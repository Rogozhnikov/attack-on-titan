import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadState, saveCity, savePlayer } from "./api";
import { buildingOptions, characters, expeditionSites, resourceLabels } from "./data";
import type { Character, CityState, MissionState, Player, ResourceKey } from "./types";
import "./styles.css";

const profileKey = "aotRecruitProfileV2";

function defaultCityState(): CityState {
  return {
    resources: { food: 120, wood: 70, stone: 40, iron: 25, people: 18 },
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `sina-${index + 1}`, buildingId: null })),
    unlockedWalls: ["sina"],
    lastTickAt: new Date().toISOString()
  };
}

function createMissionState(): MissionState {
  return {
    active: true,
    finished: false,
    actions: 6,
    risk: 10,
    resources: { food: 0, wood: 0, stone: 0, iron: 0, people: 0 },
    log: ["Отряд вышел за стену. Нужно собрать ресурсы и вернуться."],
    report: ""
  };
}

function App() {
  const saved = readLocalProfile();
  const [token, setToken] = useState(saved.token || "");
  const [name, setName] = useState(saved.name || "");
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
      const payload = await savePlayer({ token, name, characterId: selectedId, mode });
      setToken(payload.token);
      setPlayer(payload.player);
      setCity(applyProduction(payload.player.cityState || defaultCityState()));
      setScreen("city");
      setMessage("Профиль сохранен. Добро пожаловать в столицу.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось создать игрока.");
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
      cells: current.cells.map(cell => cell.id === cellId ? { ...cell, buildingId } : cell)
    }));
    setMessage(`${option.name} построено.`);
  }

  function startExpedition() {
    setMission(createMissionState());
  }

  function gather(site: typeof expeditionSites[number]) {
    if (!mission || mission.finished || mission.actions <= 0) return;
    const next = structuredClone(mission) as MissionState;
    Object.entries(site.reward).forEach(([key, value]) => {
      next.resources[key as ResourceKey] += value;
    });
    next.actions -= 1;
    next.risk = Math.min(95, next.risk + site.risk);
    next.log.push(`${site.title}: добыто ${formatReward(site.reward)}.`);
    if (site.id === "village" && Math.random() > 0.55) {
      next.resources.people += 1;
      next.log.push("Найден еще один выживший. +1 Люди.");
    }
    setMission(next.actions <= 0 ? finishMissionState(next) : next);
  }

  function finishExpedition() {
    if (!mission) return;
    const finished = finishMissionState(mission);
    setMission(finished);
    setCity(current => ({
      ...current,
      resources: addResources(current.resources, finished.resources)
    }));
    setMessage("Отряд вернулся. Добыча отправлена в город.");
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
  busy: boolean;
}) {
  return (
    <>
      <section className="hero">
        <span className="tag">стены ждут приказа</span>
        <h1>Выбери бойца и начни вылазку</h1>
      </section>

      <section className="setup-grid">
        <aside className="panel">
          <div className="panel-head"><h2>Профиль</h2><span className="tag">{props.selectedCharacter.role}</span></div>
          <label>Имя игрока</label>
          <input value={props.name} onChange={event => props.setName(event.target.value)} maxLength={24} placeholder="Например: Кадет-104" />
          <label>Режим подготовки</label>
          <div className="segmented">
            {["История", "Арена", "Выживание"].map(mode => <button key={mode} className={props.mode === mode ? "active" : ""} onClick={() => props.setMode(mode)}>{mode}</button>)}
          </div>
          <div className="preview">
            <strong>{props.name || "Без имени"}</strong>
            <span>{props.selectedCharacter.name}</span>
            <Stat label="Скорость" value={props.selectedCharacter.stats.speed} />
            <Stat label="Тактика" value={props.selectedCharacter.stats.tactic} />
            <Stat label="Воля" value={props.selectedCharacter.stats.will} />
          </div>
          <button className="primary" disabled={!props.name.trim() || props.busy} onClick={props.onCreate}>{props.busy ? "Сохраняю..." : "Создать игрока"}</button>
        </aside>

        <section className="panel">
          <div className="panel-head"><h2>Персонажи манги</h2><span className="tag">{props.visibleCharacters.length} доступно</span></div>
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
          <div className="wall-map">
            <div className="wall wall-maria locked">Стена Мария</div>
            <div className="wall wall-rose locked">Стена Роза</div>
            <div className="wall wall-sina">Стена Сина</div>
            <div className="capital">Столица</div>
          </div>
          <div className="cells">
            {props.city.cells.map(cell => <BuildCell key={cell.id} cell={cell} onBuild={props.onBuild} />)}
          </div>
        </div>

        <aside className="panel">
          <h2>Ресурсные циклы</h2>
          <p className="muted">Еда: 30с. Дерево: 45с. Камень: 50с. Железо: 70с. Люди: 120с через приют или сразу через вылазки.</p>
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

function BuildCell({ cell, onBuild }: { cell: { id: string; buildingId: string | null }; onBuild: (cellId: string, buildingId: string) => void }) {
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
            {buildingOptions.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        </>
      )}
    </div>
  );
}

function Mission({ mission, onGather, onFinish, onRestart }: { mission: MissionState; onGather: (site: typeof expeditionSites[number]) => void; onFinish: () => void; onRestart: () => void }) {
  return (
    <div className="mission-box">
      <h3>Вылазка 01: Аванпост</h3>
      <p>Действий: {mission.actions} · Риск: {mission.risk}%</p>
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
  city.cells.forEach(cell => {
    const building = buildingOptions.find(option => option.id === cell.buildingId && option.produces);
    if (!building || !building.produces) return;
    const ticks = Math.floor(elapsed / building.period);
    if (ticks > 0) {
      resources[building.produces] += ticks * building.amount;
      consumedSeconds = Math.max(consumedSeconds, ticks * building.period);
    }
  });

  return { ...city, resources, lastTickAt: new Date(last + consumedSeconds * 1000).toISOString() };
}

function finishMissionState(mission: MissionState): MissionState {
  const score = Object.entries(mission.resources).reduce((sum, [key, value]) => sum + value * (key === "people" ? 20 : 1), 0);
  const grade = score >= 90 ? "S" : score >= 70 ? "A" : score >= 50 ? "B" : "C";
  return {
    ...mission,
    finished: true,
    report: `Оценка ${grade}. Собрано ресурсов: ${score}. Людей выведено: ${mission.resources.people}.`,
    log: [...mission.log, "Отряд вернулся за стену."]
  };
}

function canPay(city: CityState, cost: Partial<Record<ResourceKey, number>>) {
  return Object.entries(cost).every(([key, value]) => city.resources[key as ResourceKey] >= (value || 0));
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
