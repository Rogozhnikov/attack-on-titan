import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { loadState, loginPlayer, saveCity, savePlayer } from "./api";
import { buildingOptions, characters, expeditionSites, gateBuildingOptions, resourceLabels } from "./data";
import type { Character, CityState, MissionState, Player, ResourceKey } from "./types";
import "./styles.css";

const profileKey = "aotRecruitProfileV2";

const mapDistricts = [
  ["district-farm d1", "Поля"], ["district-farm d2", "Поля"], ["district-farm d3", "Поля"], ["district-farm d4", "Поля"],
  ["district-town d5", "Поселение"], ["district-town d6", "Поселение"], ["district-town d7", "Поселение"], ["district-town d8", "Поселение"],
  ["district-forest d9", "Лес"], ["district-forest d10", "Лес"], ["district-quarry d11", "Каменоломня"], ["district-forge d12", "Кузница"]
];

const titanMarkers = ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8"];
const gateNames = ["Северные ворота", "Восточные ворота", "Южные ворота", "Западные ворота"];
const repairSinaGateCost: Partial<Record<ResourceKey, number>> = { wood: 45, stone: 35, iron: 15, people: 4 };
const secureSinaRoseCost: Partial<Record<ResourceKey, number>> = { food: 35, wood: 20, iron: 10, people: 6 };

const statLabels = [
  ["speed", "Скор."],
  ["tactic", "Так."],
  ["will", "Воля"]
] as const;

function defaultCityState(): CityState {
  return {
    resources: { food: 120, wood: 70, stone: 40, iron: 25, people: 18 },
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `sina-${index + 1}`, buildingId: null })),
    roseCells: Array.from({ length: 6 }, (_, index) => ({ id: `rose-${index + 1}`, buildingId: null })),
    gateCells: ["north", "east", "south", "west"].map(gate => ({ id: `gate-${gate}`, buildingId: null })),
    repairedGates: [],
    securedTerritories: [],
    unlockedWalls: ["sina"],
    lastTickAt: new Date().toISOString()
  };
}

function normalizeCityState(city: Partial<CityState> | null | undefined): CityState {
  const defaults = defaultCityState();
  const cells = Array.isArray(city?.cells) ? city.cells : defaults.cells;
  const roseCells = Array.isArray(city?.roseCells) ? city.roseCells : defaults.roseCells;
  const gateCells = Array.isArray(city?.gateCells) ? city.gateCells : defaults.gateCells;
  return {
    resources: city?.resources || defaults.resources,
    cells,
    roseCells: defaults.roseCells.map(defaultCell => roseCells.find(cell => cell.id === defaultCell.id) || defaultCell),
    gateCells: defaults.gateCells.map(defaultCell => gateCells.find(cell => cell.id === defaultCell.id) || defaultCell),
    repairedGates: Array.isArray(city?.repairedGates) ? city.repairedGates : defaults.repairedGates,
    securedTerritories: Array.isArray(city?.securedTerritories) ? city.securedTerritories : defaults.securedTerritories,
    unlockedWalls: Array.isArray(city?.unlockedWalls) ? city.unlockedWalls : defaults.unlockedWalls,
    lastTickAt: city?.lastTickAt || defaults.lastTickAt
  };
}

function createMissionState(city?: CityState, character?: Character): MissionState {
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
      character ? `${character.name} возглавляет вылазку за стену.` : "",
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
  const accountCharacter = player ? characters.find(character => character.id === player.characterId) || selectedCharacter : selectedCharacter;
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
          setCity(applyProduction(normalizeCityState(payload.currentPlayer.cityState)));
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
      setSelectedId(payload.player.characterId);
      setMode(payload.player.mode);
      setCity(applyProduction(normalizeCityState(payload.player.cityState)));
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
      setCity(applyProduction(normalizeCityState(payload.player.cityState)));
      setScreen("city");
      setPassword("");
      setMessage("Вход выполнен. Сессия сохранена в этом браузере.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Не удалось войти.");
    } finally {
      setBusy(false);
    }
  }

  function handleSwitchAccount() {
    setToken("");
    setName("");
    setPassword("");
    setPlayer(null);
    setCity(defaultCityState());
    setMission(null);
    setSelectedId(characters[0].id);
    setMode("История");
    setAuthMode("login");
    setScreen("setup");
    setMessage("Сессия закрыта. Войдите в свою учетку или создайте нового игрока.");
  }

  function build(cellId: string, buildingId: string) {
    const isGateCell = cellId.startsWith("gate-");
    const isRoseCell = cellId.startsWith("rose-");
    const option = (isGateCell ? gateBuildingOptions : buildingOptions).find(item => item.id === buildingId);
    if (!option) return;
    if (isRoseCell && !city.unlockedWalls.includes("rose")) return setMessage("Сначала почини ворота и отвоюй пространство между Стеной Сина и Стеной Роза.");
    if (isGateCell && !canUseGateAnnexes(city)) return setMessage("Пристройки у ворот станут доступны после ремонта ворот и закрепления пространства между стенами.");
    if (!canPay(city, option.cost)) return setMessage("Не хватает ресурсов для строительства.");

    setCity(current => ({
      ...current,
      resources: pay(current.resources, option.cost),
      cells: current.cells.map(cell => cell.id === cellId ? { ...cell, buildingId } : cell),
      roseCells: current.roseCells.map(cell => cell.id === cellId ? { ...cell, buildingId } : cell),
      gateCells: current.gateCells.map(cell => cell.id === cellId ? { ...cell, buildingId } : cell),
      lastTickAt: new Date().toISOString()
    }));
    setMessage(`${option.name} построено.`);
  }

  function repairSinaGates() {
    if (city.repairedGates.includes("sina")) return;
    if (!canPay(city, repairSinaGateCost)) return setMessage(`Для ремонта ворот нужно: ${formatCost(repairSinaGateCost)}.`);
    setCity(current => ({
      ...current,
      resources: pay(current.resources, repairSinaGateCost),
      repairedGates: current.repairedGates.includes("sina") ? current.repairedGates : [...current.repairedGates, "sina"],
      lastTickAt: new Date().toISOString()
    }));
    setMessage("Ворота Стены Сина отремонтированы. Теперь можно закрепить пространство до Стены Роза.");
  }

  function secureSinaRoseTerritory() {
    if (city.securedTerritories.includes("sina-rose")) return;
    if (!city.repairedGates.includes("sina")) return setMessage("Сначала нужно отремонтировать ворота Стены Сина.");
    if (!canPay(city, secureSinaRoseCost)) return setMessage(`Для закрепления пространства нужно: ${formatCost(secureSinaRoseCost)}.`);
    setCity(current => ({
      ...current,
      resources: pay(current.resources, secureSinaRoseCost),
      securedTerritories: current.securedTerritories.includes("sina-rose") ? current.securedTerritories : [...current.securedTerritories, "sina-rose"],
      unlockedWalls: current.unlockedWalls.includes("rose") ? current.unlockedWalls : [...current.unlockedWalls, "rose"],
      lastTickAt: new Date().toISOString()
    }));
    setMessage("Пояс между Стеной Сина и Стеной Роза закреплен. Новые участки доступны для строительства.");
  }

  function startExpedition() {
    setMission(createMissionState(city, accountCharacter));
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
          character={accountCharacter}
          city={city}
          onSwitchAccount={handleSwitchAccount}
          onBuild={build}
          onRepairSinaGates={repairSinaGates}
          onSecureSinaRoseTerritory={secureSinaRoseTerritory}
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
  const rosterLocked = props.authMode === "login";

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

        <section className={`panel ${rosterLocked ? "muted-panel roster-locked" : ""}`}>
          <div className="panel-head"><h2>Персонажи манги</h2><span className="tag">{props.visibleCharacters.length} доступно</span></div>
          {props.authMode === "login" && <p className="muted login-note">При входе персонаж и город загрузятся из сохраненной учетки. Выбор ростера нужен только при создании нового игрока.</p>}
          <div className="filters">
            <input value={props.query} onChange={event => props.setQuery(event.target.value)} placeholder="Найти персонажа" />
            <div className="chips">{props.roles.map(role => <button key={role} className={props.role === role ? "active" : ""} onClick={() => props.setRole(role)}>{role}</button>)}</div>
          </div>
          <div className="character-grid">
            {props.visibleCharacters.map(character => (
              <CharacterCard
                key={character.id}
                character={character}
                selected={props.selectedId === character.id}
                disabled={rosterLocked}
                onClick={() => props.setSelectedId(character.id)}
              />
            ))}
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
  onSwitchAccount: () => void;
  onBuild: (cellId: string, buildingId: string) => void;
  onRepairSinaGates: () => void;
  onSecureSinaRoseTerritory: () => void;
  onStartExpedition: () => void;
  mission: MissionState | null;
  onGather: (site: typeof expeditionSites[number]) => void;
  onFinishMission: () => void;
  onRestartMission: () => void;
}) {
  const builtCells = props.city.cells.filter(cell => cell.buildingId).length;
  const freeCells = props.city.cells.length - builtCells;
  const builtGateCells = props.city.gateCells.filter(cell => cell.buildingId).length;
  const freeGateCells = props.city.gateCells.length - builtGateCells;
  const roseUnlocked = props.city.unlockedWalls.includes("rose");
  const gatesRepaired = props.city.repairedGates.includes("sina");
  const territorySecured = props.city.securedTerritories.includes("sina-rose");
  const gateAnnexesUnlocked = gatesRepaired && territorySecured;
  const builtRoseCells = props.city.roseCells.filter(cell => cell.buildingId).length;
  const freeRoseCells = props.city.roseCells.length - builtRoseCells;
  const hasMission = Boolean(props.mission?.active && !props.mission.finished);

  return (
    <>
      <section className="city-hero">
        <div>
          <span className="tag">домашняя страница игрока</span>
          <h1>Столица внутри стены Сина</h1>
          <p>{props.player?.name} / {props.character.name}. Внешние стены Роза и Мария пока закрыты: сначала укрепи внутреннюю столицу.</p>
        </div>
        <div className="city-actions">
          <span className={hasMission ? "mission-pill active" : "mission-pill"}>{hasMission ? "вылазка активна" : "отряд в городе"}</span>
          <button className="secondary" onClick={props.onSwitchAccount}>Сменить аккаунт</button>
        </div>
      </section>

      <ResourceBar resources={props.city.resources} />

      <WallProgress
        gatesRepaired={gatesRepaired}
        territorySecured={territorySecured}
        roseUnlocked={roseUnlocked}
        resources={props.city.resources}
        onRepair={props.onRepairSinaGates}
        onSecure={props.onSecureSinaRoseTerritory}
      />

      <section className="city-layout">
        <div className="map-panel">
          <div className="map-toolbar">
            <div>
              <span className="eyebrow">Стена Сина</span>
              <strong>Центр управления городом</strong>
            </div>
            <div className="map-metrics">
              <span><b>{builtCells}</b> построено</span>
              <span><b>{freeCells}</b> свободно</span>
              <span><b>{builtGateCells}/{props.city.gateCells.length}</b> у ворот</span>
            </div>
          </div>
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
                    options={buildingOptions}
                    resources={props.city.resources}
                    onBuild={props.onBuild}
                  />
                ))}
                {props.city.roseCells.map((cell, index) => (
                  <MapBuildSlot
                    key={cell.id}
                    cell={cell}
                    index={index}
                    options={buildingOptions}
                    className={`rose-plot rose-plot-${index + 1}`}
                    locked={!roseUnlocked}
                    label={roseUnlocked ? undefined : "Закрыто"}
                    resources={props.city.resources}
                    onBuild={props.onBuild}
                  />
                ))}
                {props.city.gateCells.map((cell, index) => (
                  <MapBuildSlot
                    key={cell.id}
                    cell={cell}
                    index={index}
                    options={gateBuildingOptions}
                    className={`gate-plot gate-plot-${index + 1}`}
                    label={gateAnnexesUnlocked ? gateNames[index] : "Закрыто"}
                    locked={!gateAnnexesUnlocked}
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
          <div className="cells-head">
            <div>
              <span className="eyebrow">План строительства</span>
              <strong>Участки внутри столицы</strong>
            </div>
            <span>{freeCells ? `${freeCells} ожидают приказа` : "все участки заняты"}</span>
          </div>
          <div className="cells">
            {props.city.cells.map(cell => <BuildCell key={cell.id} cell={cell} options={buildingOptions} resources={props.city.resources} onBuild={props.onBuild} />)}
          </div>
          <div className="cells-head rose-cells-head">
            <div>
              <span className="eyebrow">Пояс Сина-Роза</span>
              <strong>{roseUnlocked ? "Отвоеванное пространство" : "Закрытая территория"}</strong>
            </div>
            <span>{roseUnlocked ? (freeRoseCells ? `${freeRoseCells} участков свободно` : "пояс застроен") : "нужны ремонт ворот и закрепление"}</span>
          </div>
          <div className={`cells rose-cells ${roseUnlocked ? "" : "locked-cells"}`}>
            {props.city.roseCells.map((cell, index) => (
              <BuildCell
                key={cell.id}
                cell={cell}
                title={`Участок Сина-Роза ${index + 1}`}
                options={buildingOptions}
                locked={!roseUnlocked}
                resources={props.city.resources}
                onBuild={props.onBuild}
              />
            ))}
          </div>
          <div className="cells-head gate-cells-head">
            <div>
              <span className="eyebrow">Пристройки у ворот</span>
              <strong>Значимые здания</strong>
            </div>
            <span>{freeGateCells ? `${freeGateCells} зоны свободны` : "все ворота заняты"}</span>
          </div>
          <div className="cells gate-cells">
            {props.city.gateCells.map((cell, index) => (
              <BuildCell
                key={cell.id}
                cell={cell}
                title={gateNames[index]}
                options={gateBuildingOptions}
                locked={!gateAnnexesUnlocked}
                resources={props.city.resources}
                onBuild={props.onBuild}
              />
            ))}
          </div>
        </div>

        <aside className="panel command-panel">
          <div className="panel-head compact"><h2>Штаб снабжения</h2><span className="tag">MVP</span></div>
          <h3>Ресурсные циклы</h3>
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

function WallProgress({ gatesRepaired, territorySecured, roseUnlocked, resources, onRepair, onSecure }: { gatesRepaired: boolean; territorySecured: boolean; roseUnlocked: boolean; resources: Record<ResourceKey, number>; onRepair: () => void; onSecure: () => void }) {
  const canRepair = canPayResources(resources, repairSinaGateCost);
  const canSecure = gatesRepaired && canPayResources(resources, secureSinaRoseCost);
  return (
    <section className="wall-progress">
      <div className="wall-step done">
        <span>1</span>
        <strong>Стена Сина</strong>
        <p>Внутренняя столица доступна для строительства.</p>
      </div>
      <div className={gatesRepaired ? "wall-step done" : "wall-step active"}>
        <span>2</span>
        <strong>Ремонт ворот</strong>
        <p>{gatesRepaired ? "Ворота Стены Сина держат строй." : `Цена: ${formatCost(repairSinaGateCost)}.`}</p>
        {!gatesRepaired && <button className="secondary" disabled={!canRepair} onClick={onRepair}>Починить ворота</button>}
      </div>
      <div className={territorySecured ? "wall-step done" : gatesRepaired ? "wall-step active" : "wall-step locked"}>
        <span>3</span>
        <strong>Пояс Сина-Роза</strong>
        <p>{territorySecured ? "Пространство закреплено, строительство открыто." : `Цена закрепления: ${formatCost(secureSinaRoseCost)}.`}</p>
        {!territorySecured && <button className="secondary" disabled={!canSecure} onClick={onSecure}>Закрепить территорию</button>}
      </div>
      <div className={roseUnlocked ? "wall-step active" : "wall-step locked"}>
        <span>4</span>
        <strong>Стена Роза</strong>
        <p>{roseUnlocked ? "Следующий пояс готов к развитию." : "Откроется после закрепления пространства."}</p>
      </div>
    </section>
  );
}

function CharacterCard({ character, selected, disabled = false, onClick }: { character: Character; selected: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button className={`character-card ${selected ? "selected" : ""}`} style={{ "--a": character.colors[0], "--b": character.colors[1] } as React.CSSProperties} disabled={disabled} onClick={onClick}>
      <div className="portrait" />
      <strong>{character.name}</strong>
      <span>{character.squad} / {character.role}</span>
      <div className="mini-stats">
        {statLabels.map(([key, label]) => (
          <b key={key}><span>{label}</span>{character.stats[key]}</b>
        ))}
      </div>
    </button>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return <div className="stat"><span>{label}</span><div><i style={{ width: `${value}%` }} /></div><b>{value}</b></div>;
}

function ResourceBar({ resources }: { resources: Record<ResourceKey, number> }) {
  return (
    <section className="resources">
      {(Object.keys(resourceLabels) as ResourceKey[]).map(key => (
        <div key={key} className={`resource-card ${key}`}>
          <i aria-hidden="true" />
          <span>{resourceLabels[key]}</span>
          <strong>{resources[key]}</strong>
        </div>
      ))}
    </section>
  );
}

function BuildCell({ cell, title, options, locked = false, resources, onBuild }: { cell: { id: string; buildingId: string | null }; title?: string; options: typeof buildingOptions | typeof gateBuildingOptions; locked?: boolean; resources: Record<ResourceKey, number>; onBuild: (cellId: string, buildingId: string) => void }) {
  const building = options.find(option => option.id === cell.buildingId);
  return (
    <div className={`build-cell ${locked ? "locked" : ""}`}>
      {building ? (
        <>
          {title && <small>{title}</small>}
          <strong>{building.name}</strong>
          <span>{building.description}</span>
        </>
      ) : (
        <>
          {title && <small>{title}</small>}
          <strong>{locked ? "Территория закрыта" : title ? "Свободная пристройка" : "Свободная ячейка"}</strong>
          <select disabled={locked} defaultValue="" onChange={event => event.target.value && onBuild(cell.id, event.target.value)}>
            <option value="" disabled>Построить...</option>
            {options.map(option => (
              <option key={option.id} value={option.id} disabled={!canPayResources(resources, option.cost)}>
                {option.name} · {formatCost(option.cost)}
              </option>
            ))}
          </select>
          <span>{locked ? "Сначала почини ворота и закрепи пространство между стенами." : "Недоступные здания станут активны, когда хватит ресурсов."}</span>
        </>
      )}
    </div>
  );
}

function MapBuildSlot({ cell, index, options, className = "", label, locked = false, resources, onBuild }: { cell: { id: string; buildingId: string | null }; index: number; options: typeof buildingOptions | typeof gateBuildingOptions; className?: string; label?: string; locked?: boolean; resources: Record<ResourceKey, number>; onBuild: (cellId: string, buildingId: string) => void }) {
  const building = options.find(option => option.id === cell.buildingId);
  return (
    <div className={`map-build-slot plot-${index + 1} ${className} ${locked ? "locked" : ""} ${building ? `built building-${building.id}` : "empty"}`}>
      {building ? (
        <>
          <strong>{building.name}</strong>
          <span>{building.produces ? `+${building.amount} ${resourceLabels[building.produces]}` : "отряд"}</span>
        </>
      ) : (
        <>
          <span className="plot-index">{label ? "Ворота" : `#${index + 1}`}</span>
          <strong>{label || "Пустой участок"}</strong>
          <select
            disabled={locked}
            defaultValue=""
            aria-label={`Построить здание: ${label || `участок ${index + 1}`}`}
            onChange={event => event.target.value && onBuild(cell.id, event.target.value)}
          >
            <option value="" disabled>Построить...</option>
            {options.map(option => (
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

  allCityCells(city).forEach(cell => {
    const building = allBuildingOptions().find(option => option.id === cell.buildingId && option.produces);
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
      {[...buildingOptions, ...gateBuildingOptions].map(option => (
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
  const normalizedCity = normalizeCityState(city);
  const now = Date.now();
  const last = new Date(normalizedCity.lastTickAt).getTime();
  if (!Number.isFinite(last)) return { ...normalizedCity, lastTickAt: new Date(now).toISOString() };
  const elapsed = Math.floor((now - last) / 1000);
  if (elapsed <= 0) return normalizedCity;

  const resources = { ...normalizedCity.resources };
  let consumedSeconds = 0;
  let hasProduction = false;
  allCityCells(normalizedCity).forEach(cell => {
    const building = allBuildingOptions().find(option => option.id === cell.buildingId && option.produces);
    if (!building || !building.produces) return;
    hasProduction = true;
    const ticks = Math.floor(elapsed / building.period);
    if (ticks > 0) {
      resources[building.produces] += ticks * building.amount;
      consumedSeconds = Math.max(consumedSeconds, ticks * building.period);
    }
  });

  if (!hasProduction) {
    return { ...normalizedCity, lastTickAt: new Date(now).toISOString() };
  }

  return { ...normalizedCity, resources, lastTickAt: new Date(last + consumedSeconds * 1000).toISOString() };
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
  const ids = new Set(city ? allCityCells(normalizeCityState(city)).map(cell => cell.buildingId).filter(Boolean) : []);
  const scouts = ids.has("scouts");
  const garrison = ids.has("garrison");
  const church = ids.has("church");
  const academy = ids.has("academy");
  const infirmary = ids.has("infirmary");
  const quartermaster = ids.has("quartermaster");
  const engineers = ids.has("engineers");
  const actions = 6 + (scouts ? 1 : 0) + (academy ? 1 : 0) + (quartermaster ? 1 : 0);
  const riskReduction = (scouts ? 4 : 0) + (academy ? 2 : 0) + (engineers ? 3 : 0);
  const returnRiskReduction = (garrison ? 8 : 0) + (church ? 4 : 0) + (infirmary ? 6 : 0) + (engineers ? 3 : 0);
  const summary = [
    scouts ? "Корпус разведки: +1 действие, риск точек -4%." : "",
    garrison ? "Гарнизон: риск возвращения -8%." : "",
    church ? "Церковь стен: риск возвращения -4%." : "",
    academy ? "Дом ученых: +1 действие, риск точек -2%." : "",
    infirmary ? "Лазарет: риск возвращения -6%." : "",
    quartermaster ? "Интендантство: +1 действие." : "",
    engineers ? "Инженерный двор: риск точек -3%, риск возвращения -3%." : ""
  ].filter(Boolean).join(" ");

  return { actions, riskReduction, returnRiskReduction, summary };
}

function allCityCells(city: CityState) {
  return [...city.cells, ...city.roseCells, ...city.gateCells];
}

function allBuildingOptions() {
  return [...buildingOptions, ...gateBuildingOptions];
}

function canPay(city: CityState, cost: Partial<Record<ResourceKey, number>>) {
  return canPayResources(city.resources, cost);
}

function canUseGateAnnexes(city: CityState) {
  return city.repairedGates.includes("sina") && city.securedTerritories.includes("sina-rose");
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
