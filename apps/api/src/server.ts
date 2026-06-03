import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const __dirname = dirname(fileURLToPath(import.meta.url));

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4020);
const databaseUrl = process.env.DATABASE_URL || "";
const dataFile = process.env.DATA_FILE || join(__dirname, "..", "data", "players.json");

const characterIds = new Set([
  "eren", "mikasa", "armin", "levi", "hange", "erwin", "reiner", "annie", "jean", "sasha",
  "connie", "historia", "ymir", "marco", "bertholdt", "zeke", "pieck", "porco", "gabi", "falco",
  "colt", "magath", "yelena", "onyankopon", "floch", "kenny", "uri", "frieda", "rod", "grisha",
  "carla", "hannes", "keith", "pixis", "nile", "hitch", "marlowe", "moblit", "miche", "nanaba",
  "gelgar", "petra", "oluo", "eld", "gunther", "furlan", "isabel", "louise", "willy", "lara"
]);

const modes = new Set(["История", "Арена", "Выживание"]);

type CityState = {
  resources: Record<"food" | "wood" | "stone" | "iron" | "people", number>;
  cells: Array<{ id: string; buildingId: string | null }>;
  roseCells: Array<{ id: string; buildingId: string | null }>;
  gateCells: Array<{ id: string; buildingId: string | null }>;
  repairedGates: string[];
  securedTerritories: string[];
  unlockedWalls: string[];
  lastTickAt: string;
};

type Player = {
  id: string;
  token: string;
  name: string;
  normalizedName: string;
  characterId: string;
  mode: string;
  passwordSalt: string | null;
  passwordHash: string | null;
  passwordParams: PasswordParams | null;
  cityState: CityState;
  createdAt: string;
  updatedAt: string;
};

type PasswordParams = {
  algorithm: "scrypt";
  keyLength: number;
  N: number;
  r: number;
  p: number;
  maxmem: number;
};

const passwordParams: PasswordParams = {
  algorithm: "scrypt",
  keyLength: 64,
  N: 2 ** 17,
  r: 8,
  p: 1,
  maxmem: 256 * 1024 * 1024
};

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

function normalizeCityState(cityState: Partial<CityState> | null | undefined): CityState {
  const defaults = defaultCityState();
  const cells = Array.isArray(cityState?.cells) ? cityState.cells : defaults.cells;
  const roseCells = Array.isArray(cityState?.roseCells) ? cityState.roseCells : defaults.roseCells;
  const gateCells = Array.isArray(cityState?.gateCells) ? cityState.gateCells : defaults.gateCells;
  return {
    resources: cityState?.resources || defaults.resources,
    cells,
    roseCells: defaults.roseCells.map(defaultCell => roseCells.find(cell => cell.id === defaultCell.id) || defaultCell),
    gateCells: defaults.gateCells.map(defaultCell => gateCells.find(cell => cell.id === defaultCell.id) || defaultCell),
    repairedGates: Array.isArray(cityState?.repairedGates) ? cityState.repairedGates : defaults.repairedGates,
    securedTerritories: Array.isArray(cityState?.securedTerritories) ? cityState.securedTerritories : defaults.securedTerritories,
    unlockedWalls: Array.isArray(cityState?.unlockedWalls) ? cityState.unlockedWalls : defaults.unlockedWalls,
    lastTickAt: cityState?.lastTickAt || defaults.lastTickAt
  };
}

function sanitizeName(value: unknown) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeName(value: unknown) {
  return sanitizeName(value).toLocaleLowerCase("ru-RU");
}

function sanitizeToken(value: unknown) {
  const token = String(value || "").trim();
  return /^[a-f0-9-]{32,64}$/i.test(token) ? token : "";
}

function sanitizePassword(value: unknown) {
  return String(value || "");
}

async function hashPassword(password: string) {
  const salt = randomBytes(24).toString("base64");
  const key = await derivePasswordKey(password, salt, passwordParams);
  return { salt, hash: key.toString("base64"), params: passwordParams };
}

async function verifyPassword(password: string, salt: string | null, hash: string | null, params: PasswordParams | null) {
  if (!salt || !hash || !params) return false;
  const key = await derivePasswordKey(password, salt, params);
  const stored = Buffer.from(hash, "base64");
  return key.length === stored.length && timingSafeEqual(key, stored);
}

function derivePasswordKey(password: string, salt: string, params: PasswordParams) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, params.keyLength, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function publicPlayer(player: Player) {
  return {
    id: player.id,
    name: player.name,
    characterId: player.characterId,
    mode: player.mode,
    cityState: player.cityState,
    updatedAt: player.updatedAt
  };
}

interface Store {
  init(): Promise<void>;
  listPlayers(): Promise<Player[]>;
  findByToken(token: string): Promise<Player | null>;
  login(input: { name: string; password: string }): Promise<{ token: string; player: Player; players: Player[] }>;
  createOrUpdate(input: { token: string; name: string; password: string; characterId: string; mode: string }): Promise<{ token: string; player: Player; players: Player[] }>;
  saveCity(token: string, cityState: CityState): Promise<Player | null>;
}

class JsonStore implements Store {
  async init() {
    await mkdir(dirname(dataFile), { recursive: true });
    try {
      await readFile(dataFile, "utf8");
    } catch {
      await this.write({ players: [] });
    }
  }

  async listPlayers() {
    return (await this.read()).players;
  }

  async findByToken(token: string) {
    return (await this.read()).players.find(player => player.token === token) || null;
  }

  async login(input: { name: string; password: string }) {
    const store = await this.read();
    const player = store.players.find(item => item.normalizedName === normalizeName(input.name));
    if (!player || !(await verifyPassword(input.password, player.passwordSalt, player.passwordHash, player.passwordParams))) {
      throw Object.assign(new Error("Неверное имя учетки или пароль."), { statusCode: 401 });
    }
    return { token: player.token, player, players: store.players };
  }

  async createOrUpdate(input: { token: string; name: string; password: string; characterId: string; mode: string }) {
    const store = await this.read();
    const current = store.players.find(player => player.token === input.token);
    const owner = store.players.find(player => normalizeName(player.name) === normalizeName(input.name) && player.token !== input.token);
    if (owner) throw Object.assign(new Error(`Учетка "${owner.name}" уже создана другим игроком.`), { statusCode: 409 });

    const passwordData = input.password ? await hashPassword(input.password) : null;
    const now = new Date().toISOString();
    let player = current;
    if (player) {
      player.name = input.name;
      player.normalizedName = normalizeName(input.name);
      player.characterId = input.characterId;
      player.mode = input.mode;
      if (passwordData) {
        player.passwordSalt = passwordData.salt;
        player.passwordHash = passwordData.hash;
        player.passwordParams = passwordData.params;
      }
      player.updatedAt = now;
    } else {
      player = {
        id: randomUUID(),
        token: input.token,
        name: input.name,
        normalizedName: normalizeName(input.name),
        characterId: input.characterId,
        mode: input.mode,
        passwordSalt: passwordData?.salt || null,
        passwordHash: passwordData?.hash || null,
        passwordParams: passwordData?.params || null,
        cityState: defaultCityState(),
        createdAt: now,
        updatedAt: now
      };
      store.players.push(player);
    }

    await this.write(store);
    return { token: input.token, player, players: store.players };
  }

  async saveCity(token: string, cityState: CityState) {
    const store = await this.read();
    const player = store.players.find(item => item.token === token);
    if (!player) return null;
    player.cityState = normalizeCityState(cityState);
    player.updatedAt = new Date().toISOString();
    await this.write(store);
    return player;
  }

  private async read(): Promise<{ players: Player[] }> {
    await this.init();
    const raw = await readFile(dataFile, "utf8");
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return { players: Array.isArray(parsed.players) ? parsed.players : [] };
  }

  private async write(store: { players: Player[] }) {
    const tempFile = `${dataFile}.tmp`;
    await writeFile(tempFile, JSON.stringify(store, null, 2));
    await rename(tempFile, dataFile);
  }
}

class PostgresStore implements Store {
  private pool = new Pool({ connectionString: databaseUrl });

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS players (
        id uuid PRIMARY KEY,
        token text UNIQUE NOT NULL,
        name text NOT NULL,
        normalized_name text UNIQUE NOT NULL,
        password_salt text,
        password_hash text,
        password_params jsonb,
        character_id text NOT NULL,
        mode text NOT NULL,
        city_state jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
    await this.pool.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS password_salt text");
    await this.pool.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS password_hash text");
    await this.pool.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS password_params jsonb");
  }

  async listPlayers() {
    const result = await this.pool.query("SELECT * FROM players ORDER BY created_at ASC");
    return result.rows.map(rowToPlayer);
  }

  async findByToken(token: string) {
    const result = await this.pool.query("SELECT * FROM players WHERE token = $1", [token]);
    return result.rows[0] ? rowToPlayer(result.rows[0]) : null;
  }

  async login(input: { name: string; password: string }) {
    const result = await this.pool.query("SELECT * FROM players WHERE normalized_name = $1", [normalizeName(input.name)]);
    const player = result.rows[0] ? rowToPlayer(result.rows[0]) : null;
    if (!player || !(await verifyPassword(input.password, player.passwordSalt, player.passwordHash, player.passwordParams))) {
      throw Object.assign(new Error("Неверное имя учетки или пароль."), { statusCode: 401 });
    }
    return { token: player.token, player, players: await this.listPlayers() };
  }

  async createOrUpdate(input: { token: string; name: string; password: string; characterId: string; mode: string }) {
    const current = await this.findByToken(input.token);
    const now = new Date().toISOString();
    const passwordData = input.password ? await hashPassword(input.password) : null;

    try {
      const result = await this.pool.query(
        current
          ? `UPDATE players SET name = $2, normalized_name = $3, character_id = $4, mode = $5,
               password_salt = COALESCE($6, password_salt), password_hash = COALESCE($7, password_hash),
               password_params = COALESCE($8::jsonb, password_params), updated_at = $9
             WHERE token = $1 RETURNING *`
          : `INSERT INTO players (id, token, name, normalized_name, character_id, mode, city_state, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
        current
          ? [input.token, input.name, normalizeName(input.name), input.characterId, input.mode, passwordData?.salt || null, passwordData?.hash || null, passwordData ? JSON.stringify(passwordData.params) : null, now]
          : [randomUUID(), input.token, input.name, normalizeName(input.name), input.characterId, input.mode, JSON.stringify(defaultCityState()), now]
      );

      let player = rowToPlayer(result.rows[0]);
      if (!current && passwordData) {
        const passwordResult = await this.pool.query(
          "UPDATE players SET password_salt = $2, password_hash = $3, password_params = $4 WHERE token = $1 RETURNING *",
          [input.token, passwordData.salt, passwordData.hash, JSON.stringify(passwordData.params)]
        );
        player = rowToPlayer(passwordResult.rows[0]);
      }
      return { token: input.token, player, players: await this.listPlayers() };
    } catch (error: any) {
      if (error?.code === "23505") {
        throw Object.assign(new Error(`Учетка "${input.name}" уже создана другим игроком.`), { statusCode: 409 });
      }
      throw error;
    }
  }

  async saveCity(token: string, cityState: CityState) {
    const result = await this.pool.query(
      "UPDATE players SET city_state = $2, updated_at = $3 WHERE token = $1 RETURNING *",
      [token, JSON.stringify(normalizeCityState(cityState)), new Date().toISOString()]
    );
    return result.rows[0] ? rowToPlayer(result.rows[0]) : null;
  }
}

function rowToPlayer(row: any): Player {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    normalizedName: row.normalized_name || normalizeName(row.name),
    characterId: row.character_id,
    mode: row.mode,
    passwordSalt: row.password_salt || null,
    passwordHash: row.password_hash || null,
    passwordParams: row.password_params || null,
    cityState: normalizeCityState(row.city_state),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at
  };
}

const store: Store = databaseUrl ? new PostgresStore() : new JsonStore();
const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await store.init();

app.get("/api/health", async () => ({ ok: true, storage: databaseUrl ? "postgres" : "json" }));

app.get("/api/state", async request => {
  const query = request.query as { token?: string };
  const token = sanitizeToken(query.token);
  const currentPlayer = token ? await store.findByToken(token) : null;
  const players = await store.listPlayers();
  return { players: players.map(publicPlayer), currentPlayer: currentPlayer ? publicPlayer(currentPlayer) : null };
});

app.post("/api/players", async (request, reply) => {
  const body = request.body as { token?: string; name?: string; password?: string; characterId?: string; mode?: string };
  const name = sanitizeName(body.name);
  const password = sanitizePassword(body.password);
  const characterId = String(body.characterId || "");
  const mode = modes.has(body.mode || "") ? String(body.mode) : "История";
  const token = sanitizeToken(body.token) || randomUUID();

  if (name.length < 2) return reply.code(400).send({ error: "BAD_NAME", message: "Имя игрока должно быть не короче 2 символов." });
  if (password.length < 6) return reply.code(400).send({ error: "BAD_PASSWORD", message: "Пароль должен быть не короче 6 символов." });
  if (!characterIds.has(characterId)) return reply.code(400).send({ error: "BAD_CHARACTER", message: "Такого персонажа нет в ростере." });

  try {
    const result = await store.createOrUpdate({ token, name, password, characterId, mode });
    return { token: result.token, player: publicPlayer(result.player), players: result.players.map(publicPlayer) };
  } catch (error: any) {
    if (error?.statusCode === 409) return reply.code(409).send({ error: "ACCOUNT_TAKEN", message: error.message, players: (await store.listPlayers()).map(publicPlayer) });
    throw error;
  }
});

app.post("/api/login", async (request, reply) => {
  const body = request.body as { name?: string; password?: string };
  const name = sanitizeName(body.name);
  const password = sanitizePassword(body.password);

  if (name.length < 2 || password.length < 1) {
    return reply.code(400).send({ error: "BAD_LOGIN", message: "Введите имя учетки и пароль." });
  }

  try {
    const result = await store.login({ name, password });
    return { token: result.token, player: publicPlayer(result.player), players: result.players.map(publicPlayer) };
  } catch (error: any) {
    if (error?.statusCode === 401) return reply.code(401).send({ error: "BAD_CREDENTIALS", message: error.message });
    throw error;
  }
});

app.put("/api/city", async (request, reply) => {
  const body = request.body as { token?: string; cityState?: CityState };
  const token = sanitizeToken(body.token);
  if (!token) return reply.code(401).send({ error: "NO_TOKEN", message: "Нужен токен игрока." });
  if (!body.cityState?.resources || !Array.isArray(body.cityState.cells)) return reply.code(400).send({ error: "BAD_CITY", message: "Некорректное состояние города." });

  const player = await store.saveCity(token, body.cityState);
  if (!player) return reply.code(404).send({ error: "PLAYER_NOT_FOUND", message: "Игрок не найден." });
  return { player: publicPlayer(player) };
});

await app.listen({ host, port });
