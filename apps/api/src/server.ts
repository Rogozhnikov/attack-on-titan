import cors from "@fastify/cors";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
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
  unlockedWalls: string[];
  lastTickAt: string;
};

type Player = {
  id: string;
  token: string;
  name: string;
  characterId: string;
  mode: string;
  cityState: CityState;
  createdAt: string;
  updatedAt: string;
};

function defaultCityState(): CityState {
  return {
    resources: { food: 120, wood: 70, stone: 40, iron: 25, people: 18 },
    cells: Array.from({ length: 9 }, (_, index) => ({ id: `sina-${index + 1}`, buildingId: null })),
    unlockedWalls: ["sina"],
    lastTickAt: new Date().toISOString()
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
  createOrUpdate(input: { token: string; name: string; characterId: string; mode: string }): Promise<{ token: string; player: Player; players: Player[] }>;
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

  async createOrUpdate(input: { token: string; name: string; characterId: string; mode: string }) {
    const store = await this.read();
    const current = store.players.find(player => player.token === input.token);
    const owner = store.players.find(player => normalizeName(player.name) === normalizeName(input.name) && player.token !== input.token);
    if (owner) throw Object.assign(new Error(`Учетка "${owner.name}" уже создана другим игроком.`), { statusCode: 409 });

    const now = new Date().toISOString();
    let player = current;
    if (player) {
      player.name = input.name;
      player.characterId = input.characterId;
      player.mode = input.mode;
      player.updatedAt = now;
    } else {
      player = {
        id: randomUUID(),
        token: input.token,
        name: input.name,
        characterId: input.characterId,
        mode: input.mode,
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
    player.cityState = cityState;
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
        character_id text NOT NULL,
        mode text NOT NULL,
        city_state jsonb NOT NULL,
        created_at timestamptz NOT NULL,
        updated_at timestamptz NOT NULL
      )
    `);
  }

  async listPlayers() {
    const result = await this.pool.query("SELECT * FROM players ORDER BY created_at ASC");
    return result.rows.map(rowToPlayer);
  }

  async findByToken(token: string) {
    const result = await this.pool.query("SELECT * FROM players WHERE token = $1", [token]);
    return result.rows[0] ? rowToPlayer(result.rows[0]) : null;
  }

  async createOrUpdate(input: { token: string; name: string; characterId: string; mode: string }) {
    const current = await this.findByToken(input.token);
    const now = new Date().toISOString();

    try {
      const result = await this.pool.query(
        current
          ? `UPDATE players SET name = $2, normalized_name = $3, character_id = $4, mode = $5, updated_at = $6 WHERE token = $1 RETURNING *`
          : `INSERT INTO players (id, token, name, normalized_name, character_id, mode, city_state, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING *`,
        current
          ? [input.token, input.name, normalizeName(input.name), input.characterId, input.mode, now]
          : [randomUUID(), input.token, input.name, normalizeName(input.name), input.characterId, input.mode, JSON.stringify(defaultCityState()), now]
      );
      return { token: input.token, player: rowToPlayer(result.rows[0]), players: await this.listPlayers() };
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
      [token, JSON.stringify(cityState), new Date().toISOString()]
    );
    return result.rows[0] ? rowToPlayer(result.rows[0]) : null;
  }
}

function rowToPlayer(row: any): Player {
  return {
    id: row.id,
    token: row.token,
    name: row.name,
    characterId: row.character_id,
    mode: row.mode,
    cityState: row.city_state || defaultCityState(),
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
  const body = request.body as { token?: string; name?: string; characterId?: string; mode?: string };
  const name = sanitizeName(body.name);
  const characterId = String(body.characterId || "");
  const mode = modes.has(body.mode || "") ? String(body.mode) : "История";
  const token = sanitizeToken(body.token) || randomUUID();

  if (name.length < 2) return reply.code(400).send({ error: "BAD_NAME", message: "Имя игрока должно быть не короче 2 символов." });
  if (!characterIds.has(characterId)) return reply.code(400).send({ error: "BAD_CHARACTER", message: "Такого персонажа нет в ростере." });

  try {
    const result = await store.createOrUpdate({ token, name, characterId, mode });
    return { token: result.token, player: publicPlayer(result.player), players: result.players.map(publicPlayer) };
  } catch (error: any) {
    if (error?.statusCode === 409) return reply.code(409).send({ error: "ACCOUNT_TAKEN", message: error.message, players: (await store.listPlayers()).map(publicPlayer) });
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
