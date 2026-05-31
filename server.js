const http = require("http");
const fs = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

const host = process.env.HOST || "127.0.0.1";
const port = Number(process.env.PORT || 4020);
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const dataFile = path.join(dataDir, "players.json");

const characterIds = new Set([
  "eren",
  "mikasa",
  "armin",
  "levi",
  "hange",
  "erwin",
  "reiner",
  "annie",
  "jean",
  "sasha",
  "connie",
  "historia",
  "ymir",
  "marco",
  "bertholdt",
  "zeke",
  "pieck",
  "porco",
  "gabi",
  "falco",
  "colt",
  "magath",
  "yelena",
  "onyankopon",
  "floch",
  "kenny",
  "uri",
  "frieda",
  "rod",
  "grisha",
  "carla",
  "hannes",
  "keith",
  "pixis",
  "nile",
  "hitch",
  "marlowe",
  "moblit",
  "miche",
  "nanaba",
  "gelgar",
  "petra",
  "oluo",
  "eld",
  "gunther",
  "furlan",
  "isabel",
  "louise",
  "willy",
  "lara"
]);

const modes = new Set(["История", "Арена", "Выживание"]);

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify({ players: [] }, null, 2));
  }
}

async function readStore() {
  await ensureStore();
  const raw = await fs.readFile(dataFile, "utf8");
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ""));
  return { players: Array.isArray(parsed.players) ? parsed.players : [] };
}

async function writeStore(store) {
  await ensureStore();
  const tempFile = `${dataFile}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(store, null, 2));
  await fs.rename(tempFile, dataFile);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    characterId: player.characterId,
    mode: player.mode,
    updatedAt: player.updatedAt
  };
}

function sanitizeName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 24);
}

function normalizeName(value) {
  return sanitizeName(value).toLocaleLowerCase("ru-RU");
}

function sanitizeToken(value) {
  const token = String(value || "").trim();
  return /^[a-f0-9-]{32,64}$/i.test(token) ? token : "";
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 8192) {
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
  }
  return body ? JSON.parse(body) : {};
}

async function handleState(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = sanitizeToken(url.searchParams.get("token"));
  const store = await readStore();
  const currentPlayer = token ? store.players.find(player => player.token === token) : null;

  sendJson(res, 200, {
    players: store.players.map(publicPlayer),
    currentPlayer: currentPlayer ? publicPlayer(currentPlayer) : null
  });
}

async function handleCreateOrUpdate(req, res) {
  const body = await readBody(req);
  const name = sanitizeName(body.name);
  const characterId = String(body.characterId || "");
  const mode = modes.has(body.mode) ? body.mode : "История";
  const token = sanitizeToken(body.token) || crypto.randomUUID();

  if (name.length < 2) {
    sendJson(res, 400, { error: "BAD_NAME", message: "Имя игрока должно быть не короче 2 символов." });
    return;
  }

  if (!characterIds.has(characterId)) {
    sendJson(res, 400, { error: "BAD_CHARACTER", message: "Такого персонажа нет в ростере." });
    return;
  }

  const store = await readStore();
  const currentPlayer = store.players.find(player => player.token === token);
  const accountOwner = store.players.find(player => normalizeName(player.name) === normalizeName(name) && player.token !== token);

  if (accountOwner) {
    sendJson(res, 409, {
      error: "ACCOUNT_TAKEN",
      message: `Учетка "${accountOwner.name}" уже создана другим игроком.`,
      owner: publicPlayer(accountOwner),
      players: store.players.map(publicPlayer)
    });
    return;
  }

  const now = new Date().toISOString();
  let player = currentPlayer;

  if (player) {
    player.name = name;
    player.characterId = characterId;
    player.mode = mode;
    player.updatedAt = now;
  } else {
    player = {
      id: crypto.randomUUID(),
      token,
      name,
      characterId,
      mode,
      createdAt: now,
      updatedAt: now
    };
    store.players.push(player);
  }

  await writeStore(store);

  sendJson(res, 200, {
    token,
    player: publicPlayer(player),
    players: store.players.map(publicPlayer)
  });
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      await handleState(req, res);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/players") {
      await handleCreateOrUpdate(req, res);
      return;
    }

    sendJson(res, 404, { error: "NOT_FOUND", message: "Маршрут не найден." });
  } catch (error) {
    const status = error.statusCode || 500;
    const message = status === 500 ? "Внутренняя ошибка сервера." : error.message;
    sendJson(res, status, { error: "SERVER_ERROR", message });
  }
}

ensureStore()
  .then(() => {
    http.createServer(handleRequest).listen(port, host, () => {
      console.log(`Titan API listening on http://${host}:${port}`);
    });
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
