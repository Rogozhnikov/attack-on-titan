import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadState, loginPlayer, saveCity, savePlayer } from "./api";
import { buildingOptions, characters, expeditionSites, resourceLabels } from "./data";
import type { Character, CityState, MissionState, Player, ResourceKey } from "./types";
import "./styles.css";

const profileKey = "aotRecruitProfileV2";

const mapDistricts = [
  ["district-farm d1", "Поля"], ["district-farm d2", "Поля"], ["district-farm d3", "Поля"], ["district-farm d4", "Поля"],
  ["district-town d5", "Поселение"], ["district-town d6", "Поселение"], ["district-town d7", "Поселение"], ["district-town d8", "Поселение"],
  ["district-forest d9", "Лес"], ["district-forest d10", "Лес"], ["district-quarry d11", "Каменоломня"], ["district-forge d12", "Кузница"]
];

const titanMarkers = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];

function defaultCityState(): CityState {
  return {
    resources: { food: 120, wood: 70, stone: 40, iron: 25, people: 18 },
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `sina-${index + 1}`, buildingId: null })),
    unlockedWalls: ["sina"],
    lastTickAt: new Date().toISOString()
  };
}

function createMissionState(city?: CityState): MissionState {
  const bonuses = getExpeditionBonuses(city);
  return {
    active: true,
    finished: false,
    actions: bonuses.actions,
    maxActions: bonuses.actions,
    risk: Math.max(5, 10 - bonuses.riskReduction),
    returnRiskBonus: bonuses.returnRiskReduction,
    resources: { food: 0, wood: 0, stone: 0, iron: 0, people: 0 },
    log: [
      "Отряд вышел за стену. Нужно собрать ресурсы и вернуться.",
      bonuses.summary
    ].filter(Boolean),
    report: ""
  };
}

function App() {
  const saved = readLocalProfile();
  const [token, setToken] = useState(saved.token || "");
  const [name, setName] = useState(saved.name || "");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState<"create" | "login">("create");
  const [mode, setMode] = useState(saved.mode || "История");
  const [selectedId, setSelectedId] = useState(saved.selectedId || characters[0].id);
  const [query, setQuery] = useState("");
  const [role, setRole] = useState("Все");
  const [player, setPlayer] = useState<Player | null>(null);
  const [city, setCity] = useState<CityState>(defaultCityState());
  const [screen, setScreen] = useState<"setup" | "city">("setup");
  const [message, setMessage] = useState("Подключаюсь к серверу игроков.");
  const [mission, setMission] = useState<MissionState | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedCharacter = characters.find(character => character.id === selectedId) || characters[0];
  const roles = ["Все", "Разведкорпус", "Кадеты", "Марли", "Гарнизон", "Военная полиция"];
  const visibleCharacters = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("ru-RU");
    return characters.filter(character => {
      const byRole = role === "Все" || character.squad === role;
      const byQuery = !normalized || `${character.name} ${character.squad} ${character.role}`.toLocaleLowerCase("ru-RU").includes(normalized);
      return byRole && byQuery;
    });
  }, [query, role]);

  useEffect(() => {
    loadState(token)
      .then(payload => {
        if (payload.currentPlayer) {
          setPlayer(payload.currentPlayer);
          setName(payload.currentPlayer.name);
          setSelectedId(payload.currentPlayer.characterId);
          setMode(payload.currentPlayer.mode);
          setCity(applyProduction(payload.currentPlayer.cityState || defaultCityState()));
          setScreen("city");
          setMessage("Профиль загружен.");
        } else {
          setMessage("Сервер подключен.");
        }
      })
      .catch(error => setMessage(error.message));
  }, []);

  useEffect(() => {
    writeLocalProfile({ token, name, selectedId, mode });
  }, [token, name, selectedId, mode]);

  useEffect(() => {
    if (!player || screen !== "city") return;
    const timer = window.setInterval(() => {
      setCity(current => applyProduction(current));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [player, screen]);

  useEffect(() => {
    if (!player || !token || screen !== "city") return;
    const timer = window.setTimeout(() => {
      saveCity(token, city).catch(() => undefined);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [city, player, screen, token]);

  async function handleCreatePlayer() {
    setBusy(true);
    try {
      const payload = await savePlayer({ token, name, password, characterId: selectedId, mode });
      setToken(payload.token);
      setPlayer(payload.player);
      setCity(applyProduction(payload.player.cityState || defaultCityState()));
      setScreen("city");
      setPassword("");
      setMessage("Профиль сохранен. Добро пожаловать в столицу.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось создать игрока.");
    } finally {
      setBusy(false);
    }
  }

  async function handleLogin() {
    setBusy(true);
    try {
      const payload = await loginPlayer({ name, password });
      setToken(payload.token);
      setPlayer(payload.player);
      setSelectedId(payload.player.characterId);
      setMode(payload.player.mode);
      setCity(applyProduction(payload.player.cityState || defaultCityState()));
      setScreen("city");
      setPassword("");
      setMessage("Вход выполнен. Сессия сохранена в этом браузере.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось войти.");
    } finally {
      setBusy(false);
    }
  }

  function build(cellId: string, buildingId: string) {
    const option = buildingOptions.find(item => item.id === buildingId);
    if (!option) return;
    if (!canPay(city, option.cost)) return setMessage("Не хватает ресурсов для строительства.");

    setCity(current => ({
      ...current,
      resources: pay(current.resources, option.cost),
      cells: current.cells.map(cell => cell.id === cellId ? { ...cell, buildingId } : cell),
      lastTickAt: new Date().toISOString()
    }));
    setMessage(`${option.name} построено.`);
  }

  function startExpedition() {
    setMission(createMissionState(city));
  }

  function gather(site: typeof expeditionSites[number]) {
    if (!mission || mission.finished || mission.actions <= 0) return;
    const next = structuredClone(mission) as MissionState;
    Object.entries(site.reward).forEach(([key, value]) => {
      next.resources[key as ResourceKey] += value;
    });
    next.actions -= 1;
    const bonuses = getExpeditionBonuses(city);
    next.risk = Math.min(95, next.risk + Math.max(3, site.risk - bonuses.riskReduction));
    next.log.push(`${site.title}: добыто ${formatReward(site.reward)}.`);
    if (site.id === "village" && Math.random() > 0.55) {
      next.resources.people += 1;
      next.log.push("Найден еще один выживший. +1 Люди.");
    }
    if (next.actions <= 0) {
      completeExpedition(next);
    } else {
      setMission(next);
    }
  }

  function finishExpedition() {
    if (!mission) return;
    completeExpedition(mission);
  }

  function completeExpedition(baseMission: MissionState) {
    const finished = finishMissionState(baseMission);
    setMission(finished);
    setCity(current => ({
      ...current,
      resources: addResources(current.resources, finished.resources)
    }));
    setMessage("Отряд вернулся. Добыча отправлена в город и будет сохранена.");
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark">A</div>
        <div>
          <strong>Attack on Titan: Recruit</strong>
          <span>{screen === "city" ? "столица стены Сина" : "создание игрока"}</span>
        </div>
        <div className="status">{message}</div>
      </header>

      {screen === "setup" ? (
        <SetupScreen
          name={name}
          setName={setName}
          password={password}
          setPassword={setPassword}
          authMode={authMode}
          setAuthMode={setAuthMode}
          mode={mode}
          setMode={setMode}
          selectedCharacter={selectedCharacter}
          selectedId={selectedId}
          setSelectedId={setSelectedId}
          query={query}
          setQuery={setQuery}
          role={role}
          setRole={setRole}
          roles={roles}
          visibleCharacters={visibleCharacters}
          onCreate={handleCreatePlayer}
          onLogin={handleLogin}
          busy={busy}
        />
      ) : (
        <CityScreen
          player={player}
          character={selectedCharacter}
          city={city}
          setScreen={setScreen}
          onBuild={build}
          onStartExpedition={startExpedition}
          mission={mission}
          onGather={gather}
          onFinishMission={finishExpedition}
          onRestartMission={startExpedition}
        />
      )}
    </main>
  );
}

function SetupScreen(props: {
  name: string;
  setName: (value: string) => void;
  password: string;
  setPassword: (value: string) => void;
  authMode: "create" | "login";
  setAuthMode: (value: "create" | "login") => void;
  mode: string;
  setMode: (value: string) => void;
  selectedCharacter: Character;
  selectedId: string;
  setSelectedId: (value: string) => void;
  query: string;
  setQuery: (value: string) => void;
  role: string;
  setRole: (value: string) => void;
  roles: string[];
  visibleCharacters: Character[];
  onCreate: () => void;
  onLogin: () => void;
  busy: boolean;
}) {
  const canSubmit = props.name.trim().length >= 2 && props.password.length >= (props.authMode === "create" ? 6 : 1) && !props.busy;

  return (
    <>
      <section className="hero">
        <span className="tag">стены ждут приказа</span>
        <h1>Выбери бойца и начни вылазку</h1>
      </section>

      <section className="setup-grid">
        <aside className="panel">
          <div className="panel-head"><h2>Профиль</h2><span className="tag">{props.selectedCharacter.role}</span></div>
          <div className="segmented auth-tabs">
            <button className={props.authMode === "create" ? "active" : ""} onClick={() => props.setAuthMode("create")}>Создать</button>
            <button className={props.authMode === "login" ? "active" : ""} onClick={() => props.setAuthMode("login")}>Войти</button>
          </div>
          <label>Имя игрока</label>
          <input value={props.name} onChange={event => props.setName(event.target.value)} maxLength={24} placeholder="Например: Кадет-104" />
          <label>Пароль</label>
          <input value={props.password} onChange={event => props.setPassword(event.target.value)} type="password" minLength={6} placeholder={props.authMode === "create" ? "Минимум 6 символов" : "Пароль учетки"} />
          {props.authMode === "create" && (
            <>
              <label>Режим подготовки</label>
              <div className="segmented">
                {["История", "Арена", "Выживание"].map(mode => <button key={mode} className={props.mode === mode ? "active" : ""} onClick={() => props.setMode(mode)}>{mode}</button>)}
              </div>
            </>
          )}
          <div className="preview">
            <strong>{props.name || "Без имени"}</strong>
            <span>{props.authMode === "create" ? props.selectedCharacter.name : "Вход в существующую учетку"}</span>
            {props.authMode === "create" && (
              <>
                <Stat label="Скорость" value={props.selectedCharacter.stats.speed} />
                <Stat label="Тактика" value={props.selectedCharacter.stats.tactic} />
                <Stat label="Воля" value={props.selectedCharacter.stats.will} />
              </>
            )}
          </div>
          <button className="primary" disabled={!canSubmit} onClick={props.authMode === "create" ? props.onCreate : props.onLogin}>
            {props.busy ? "Проверяю..." : props.authMode === "create" ? "Создать игрока" : "Войти в город"}
          </button>
        </aside>

        <section className={`panel ${props.authMode === "login" ? "muted-panel" : ""}`}>
          <div className="panel-head"><h2>Персонажи манги</h2><span className="tag">{props.visibleCharacters.length} доступно</span></div>
          {props.authMode === "login" && <p className="muted login-note">При входе персонаж и город загрузятся из сохраненной учетки. Выбор ростера нужен только при создании нового игрока.</p>}
          <div className="filters">
            <input value={props.query} onChange={event => props.setQuery(event.target.value)} placeholder="Найти персонажа" />
            <div className="chips">{props.roles.map(role => <button key={role} className={props.role === role ? "active" : ""} onClick={() => props.setRole(role)}>{role}</button>)}</div>
          </div>
          <div className="character-grid">
            {props.visibleCharacters.map(character => <CharacterCard key={character.id} character={character} selected={props.selectedId === character.id} onClick={() => props.setSelectedId(character.id)} />)}
          </div>
        </section>
      </section>
    </>
  );
}

function CityScreen(props: {
  player: Player | null;
  character: Character;
  city: CityState;
  setScreen: (screen: "setup" | "city") => void;
  onBuild: (cellId: string, buildingId: string) => void;
  onStartExpedition: () => void;
  mission: MissionState | null;
  onGather: (site: typeof expeditionSites[number]) => void;
  onFinishMission: () => void;
  onRestartMission: () => void;
}) {
  return (
    <>
      <section className="city-hero">
        <div>
          <span className="tag">домашняя страница игрока</span>
          <h1>Столица внутри стены Сина</h1>
          <p>{props.player?.name} / {props.character.name}. Внешние стены Роза и Мария пока закрыты: сначала укрепи внутреннюю столицу.</p>
        </div>
        <button className="secondary" onClick={() => props.setScreen("setup")}>К ростеру</button>
      </section>

      <ResourceBar resources={props.city.resources} />

      <section className="city-layout">
        <div className="map-panel">
          <div className="map-scroll" aria-label="Схема города и стен">
            <div className="wall-map">
              <div className="map-legend">
                <strong>Схема устройства города и стен</strong>
                <span><i className="legend-icon maria" />Стена Мария</span>
                <span><i className="legend-icon rose" />Стена Роза</span>
                <span><i className="legend-icon sina" />Стена Сина</span>
                <span><i className="legend-icon gate" />Ворота</span>
                <span><i className="legend-icon capital-icon" />Столица</span>
                <span><i className="legend-icon titan-icon" />Внешняя территория титанов</span>
              </div>

              <div className="compass"><b>N</b><span>W</span><span>E</span><em>S</em></div>
              {titanMarkers.map(marker => <div key={marker} className={`titan-marker ${marker}`} />)}

              <div className="road road-ns" />
              <div className="road road-ew" />
              {mapDistricts.map(([className, label]) => <div key={className} className={`district ${className}`}>{label}</div>)}

              <div className="wall wall-maria locked"><span>Стена Мария</span></div>
              <div className="wall wall-rose locked"><span>Стена Роза</span></div>
              <div className="wall wall-sina"><span>Стена Сина</span></div>

              <div className="map-build-plots" aria-label="Участки строительства внутри стены Сина">
                {props.city.cells.map((cell, index) => (
                  <MapBuildSlot
                    key={cell.id}
                    cell={cell}
                    index={index}
                    resources={props.city.resources}
                    onBuild={props.onBuild}
                  />
                ))}
              </div>

              <div className="gate gate-north">Ворота</div>
              <div className="gate gate-east">Ворота</div>
              <div className="gate gate-south">Ворота</div>
              <div className="gate gate-west">Ворота</div>

              <div className="capital">Столица</div>
              <div className="outer-caption">Внешняя территория титанов</div>
            </div>
          </div>
          <div className="cells">
            {props.city.cells.map(cell => <BuildCell key={cell.id} cell={cell} resources={props.city.resources} onBuild={props.onBuild} />)}
          </div>
        </div>

        <aside className="panel">
          <h2>Ресурсные циклы</h2>
          <p className="muted">Еда: 30с. Дерево: 45с. Камень: 50с. Железо: 70с. Люди: 120с через приют или сразу через вылазки.</p>
          <ProductionSummary city={props.city} />
          <BuildingCatalog resources={props.city.resources} />
          <button className="primary" onClick={props.onStartExpedition}>Вылазка за стену</button>
          {props.mission && <Mission mission={props.mission} onGather={props.onGather} onFinish={props.onFinishMission} onRestart={props.onRestartMission} />}
        </aside>
      </section>
    </>
  );
}

function CharacterCard({ character, selected, onClick }: { character: Character; selected: boolean; onClick: () => void }) {
  return (
    <button className={`character-card ${selected ? "selected" : ""}`} style={{ "--a": character.colors[0], "--b": character.colors[1] } as React.CSSProperties} onClick={onClick}>
      <div className="portrait" />
      <strong>{character.name}</strong>
      <span>{character.squad} / {character.role}</span>
      <div className="mini-stats"><b>{character.stats.speed}</b><b>{character.stats.tactic}</b><b>{character.stats.will}</b></div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="stat"><span>{label}</span><div><i style={{ width: `${value}%` }} /></div><b>{value}</b></div>;
}

function ResourceBar({ resources }: { resources: Record<ResourceKey, number> }) {
  return <section className="resources">{(Object.keys(resourceLabels) as ResourceKey[]).map(key => <div key={key}><span>{resourceLabels[key]}</span><strong>{resources[key]}</strong></div>)}</section>;
}

function BuildCell({ cell, resources, onBuild }: { cell: { id: string; buildingId: string | null }; resources: Record<ResourceKey, number>; onBuild: (cellId: string, buildingId: string) => void }) {
  const building = buildingOptions.find(option => option.id === cell.buildingId);
  return (
    <div className="build-cell">
      {building ? (
        <>
          <strong>{building.name}</strong>
          <span>{building.description}</span>
        </>
      ) : (
        <>
          <strong>Свободная ячейка</strong>
          <select defaultValue="" onChange={event => event.target.value && onBuild(cell.id, event.target.value)}>
            <option value="" disabled>Построить...</option>
            {buildingOptions.map(option => (
              <option key={option.id} value={option.id} disabled={!canPayResources(resources, option.cost)}>
                {option.name} · {formatCost(option.cost)}
              </option>
            ))}
          </select>
          <span>Недоступные здания станут активны, когда хватит ресурсов.</span>
        </>
      )}
    </div>
  );
}

function MapBuildSlot({ cell, index, resources, onBuild }: { cell: { id: string; buildingId: string | null }; index: number; resources: Record<ResourceKey, number>; onBuild: (cellId: string, buildingId: string) => void }) {
  const building = buildingOptions.find(option => option.id === cell.buildingId);
  return (
    <div className={`map-build-slot plot-${index + 1} ${building ? `built building-${building.id}` : "empty"}`}>
      {building ? (
        <>
          <strong>{building.name}</strong>
          <span>{building.produces ? `+${building.amount} ${resourceLabels[building.produces]}` : "отряд"}</span>
        </>
      ) : (
        <>
          <strong>Пустой участок</strong>
          <select
            defaultValue=""
            aria-label={`Построить здание на участке ${index + 1}`}
            onChange={event => event.target.value && onBuild(cell.id, event.target.value)}
          >
            <option value="" disabled>Построить...</option>
            {buildingOptions.map(option => (
              <option key={option.id} value={option.id} disabled={!canPayResources(resources, option.cost)}>
                {option.name} · {formatCost(option.cost)}
              </option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}

function ProductionSummary({ city }: { city: CityState }) {
  const rates = (Object.keys(resourceLabels) as ResourceKey[]).reduce<Record<ResourceKey, number>>((acc, key) => {
    acc[key] = 0;
    return acc;
  }, { food: 0, wood: 0, stone: 0, iron: 0, people: 0 });

  city.cells.forEach(cell => {
    const building = buildingOptions.find(option => option.id === cell.buildingId && option.produces);
    if (!building?.produces) return;
    rates[building.produces] += Math.round((building.amount * 3600) / building.period);
  });

  return (
    <div className="production-summary">
      {(Object.keys(resourceLabels) as ResourceKey[]).map(key => (
        <span key={key}>{resourceLabels[key]} <b>+{rates[key]}/ч</b></span>
      ))}
    </div>
  );
}

function BuildingCatalog({ resources }: { resources: Record<ResourceKey, number> }) {
  return (
    <div className="building-catalog">
      {buildingOptions.map(option => (
        <article key={option.id} className={canPayResources(resources, option.cost) ? "" : "unavailable"}>
          <strong>{option.name}</strong>
          <span>{option.description}</span>
          <small>Цена: {formatCost(option.cost)}</small>
        </article>
      ))}
    </div>
  );
}

function Mission({ mission, onGather, onFinish, onRestart }: { mission: MissionState; onGather: (site: typeof expeditionSites[number]) => void; onFinish: () => void; onRestart: () => void }) {
  return (
    <div className="mission-box">
      <h3>Вылазка 01: Аванпост</h3>
      <p>Действий: {mission.actions}/{mission.maxActions} · Риск: {mission.risk}% · Бонус возвращения: -{mission.returnRiskBonus}%</p>
      <div className="mission-sites">{expeditionSites.map(site => <button key={site.id} disabled={mission.finished || mission.actions <= 0} onClick={() => onGather(site)}>{site.title}<span>{formatReward(site.reward)}</span></button>)}</div>
      <button className="secondary" disabled={mission.finished} onClick={onFinish}>Вернуться за стену</button>
      <button className="secondary" onClick={onRestart}>Новая вылазка</button>
      <ul>{mission.log.slice(-5).map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)}</ul>
      {mission.finished && <p className="report">{mission.report}</p>}
    </div>
  );
}

function applyProduction(city: CityState): CityState {
  const now = Date.now();
  const last = new Date(city.lastTickAt).getTime();
  if (!Number.isFinite(last)) return { ...city, lastTickAt: new Date(now).toISOString() };
  const elapsed = Math.floor((now - last) / 1000);
  if (elapsed <= 0) return city;

  const resources = { ...city.resources };
  let consumedSeconds = 0;
  let hasProduction = false;
  city.cells.forEach(cell => {
    const building = buildingOptions.find(option => option.id === cell.buildingId && option.produces);
    if (!building || !building.produces) return;
    hasProduction = true;
    const ticks = Math.floor(elapsed / building.period);
    if (ticks > 0) {
      resources[building.produces] += ticks * building.amount;
      consumedSeconds = Math.max(consumedSeconds, ticks * building.period);
    }
  });

  if (!hasProduction) {
    return { ...city, lastTickAt: new Date(now).toISOString() };
  }

  return { ...city, resources, lastTickAt: new Date(last + consumedSeconds * 1000).toISOString() };
}

function finishMissionState(mission: MissionState): MissionState {
  const score = Object.entries(mission.resources).reduce((sum, [key, value]) => sum + value * (key === "people" ? 20 : 1), 0);
  const grade = score >= 90 ? "S" : score >= 70 ? "A" : score >= 50 ? "B" : "C";
  const returnRisk = Math.max(5, Math.round(mission.risk * .45) - mission.returnRiskBonus);
  return {
    ...mission,
    finished: true,
    report: `Оценка ${grade}. Собрано ресурсов: ${score}. Людей выведено: ${mission.resources.people}. Риск возвращения: ${returnRisk}%.`,
    log: [...mission.log, `Отряд вернулся за стену. Риск возвращения: ${returnRisk}%.`]
  };
}

function getExpeditionBonuses(city?: CityState) {
  const ids = new Set(city?.cells.map(cell => cell.buildingId).filter(Boolean));
  const scouts = ids.has("scouts");
  const garrison = ids.has("garrison");
  const actions = 6 + (scouts ? 1 : 0);
  const riskReduction = scouts ? 4 : 0;
  const returnRiskReduction = garrison ? 8 : 0;
  const summary = [
    scouts ? "Корпус разведки: +1 действие, риск точек -4%." : "",
    garrison ? "Гарнизон: риск возвращения -8%." : ""
  ].filter(Boolean).join(" ");

  return { actions, riskReduction, returnRiskReduction, summary };
}

function canPay(city: CityState, cost: Partial<Record<ResourceKey, number>>) {
  return canPayResources(city.resources, cost);
}

function canPayResources(resources: Record<ResourceKey, number>, cost: Partial<Record<ResourceKey, number>>) {
  return Object.entries(cost).every(([key, value]) => resources[key as ResourceKey] >= (value || 0));
}

function pay(resources: Record<ResourceKey, number>, cost: Partial<Record<ResourceKey, number>>) {
  const next = { ...resources };
  Object.entries(cost).forEach(([key, value]) => {
    next[key as ResourceKey] -= value || 0;
  });
  return next;
}

function addResources(base: Record<ResourceKey, number>, extra: Record<ResourceKey, number>) {
  const next = { ...base };
  (Object.keys(extra) as ResourceKey[]).forEach(key => {
    next[key] += extra[key];
  });
  return next;
}

function formatReward(reward: Partial<Record<ResourceKey, number>>) {
  return Object.entries(reward).map(([key, value]) => `+${value} ${resourceLabels[key as ResourceKey]}`).join(" · ");
}

function formatCost(cost: Partial<Record<ResourceKey, number>>) {
  return Object.entries(cost).map(([key, value]) => `${value} ${resourceLabels[key as ResourceKey]}`).join(", ");
}

function readLocalProfile() {
  try {
    const fromStorage = JSON.parse(localStorage.getItem(profileKey) || "{}");
    const tokenFromUrl = new URLSearchParams(window.location.search).get("token");
    return tokenFromUrl ? { ...fromStorage, token: tokenFromUrl } : fromStorage;
  } catch {
    const tokenFromUrl = new URLSearchParams(window.location.search).get("token");
    return tokenFromUrl ? { token: tokenFromUrl } : {};
  }
}

function writeLocalProfile(profile: { token: string; name: string; selectedId: string; mode: string }) {
  localStorage.setItem(profileKey, JSON.stringify(profile));
}

createRoot(document.getElementById("root")!).render(<App />);
