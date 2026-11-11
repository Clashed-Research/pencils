import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createState } from "../engine/book.mjs";

const USER_KEYS = ["balance", "positions", "agents", "notif", "resolved", "ledgers"];

let db;

function num(v) {
  return typeof v === "bigint" ? Number(v) : v;
}

export function closeStore() {
  if (!db) return;
  db.close();
  db = undefined;
}

export function openStore(file) {
  closeStore();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS book (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      ip TEXT,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_calls (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      day TEXT NOT NULL,
      market_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'page'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires INTEGER NOT NULL
    );
  `);
  const cols = db.prepare("PRAGMA table_info(ai_calls)").all();
  if (!cols.some((c) => c.name === "kind")) {
    db.exec("ALTER TABLE ai_calls ADD COLUMN kind TEXT NOT NULL DEFAULT 'page'");
  }
  return db;
}

export function loadBook() {
  const row = db.prepare("SELECT json FROM book WHERE id = 1").get();
  if (row) {
    const book = JSON.parse(row.json);
    book.ledgers = undefined;
    return book;
  }
  const fresh = createState(Date.now());
  fresh.archive = fresh.resolved || [];
  for (const key of USER_KEYS) delete fresh[key];
  fresh.balance = 0;
  fresh.positions = [];
  fresh.agents = [];
  fresh.resolved = [];
  fresh.notif = { ending: true, proposed: true, coalition: true, resolved: true };
  saveBook(fresh);
  return fresh;
}

export function saveBook(book) {
  const ledgers = book.ledgers;
  delete book.ledgers;
  const json = JSON.stringify(book);
  if (ledgers) book.ledgers = ledgers;
  db.prepare(
    "INSERT INTO book (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
  ).run(json);
}

export function blankUser(now = Date.now()) {
  return {
    id: "u_" + randomBytes(9).toString("hex"),
    balance: 250,
    positions: [],
    agents: [],
    notif: { ending: true, proposed: true, coalition: true, resolved: true },
    resolved: [],
    resetAt: 0,
    proposeHour: 0,
    proposeCount: 0,
    created: now,
  };
}

export function insertUser(user, ip) {
  db.prepare("INSERT INTO users (id, json, ip, created) VALUES (?, ?, ?, ?)").run(
    user.id,
    JSON.stringify(user),
    ip || "",
    user.created,
  );
  return user;
}

export function saveUser(user) {
  db.prepare("UPDATE users SET json = ? WHERE id = ?").run(JSON.stringify(user), user.id);
}

export function listUsers() {
  return db.prepare("SELECT json FROM users").all().map((row) => JSON.parse(row.json));
}

export function recentAccounts(ip, since) {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE ip = ? AND created > ?").get(ip, since);
  return num(row?.n || 0);
}

export function startSession(userId) {
  const token = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const expires = Date.now() + 400 * 86400000;
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)").run(tokenHash, userId, expires);
  return token;
}

export function userByToken(token) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const session = db.prepare("SELECT user_id, expires FROM sessions WHERE token_hash = ?").get(tokenHash);
  if (!session || num(session.expires) < Date.now()) return null;
  const row = db.prepare("SELECT json FROM users WHERE id = ?").get(session.user_id);
  return row ? JSON.parse(row.json) : null;
}

export function userCount() {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users").get();
  return num(row?.n || 0);
}

export function aiBudget(now = Date.now()) {
  const limit = Math.max(0, Number(process.env.NEAR_AI_DAILY_LIMIT || 6));
  const cooldownMs = Math.max(0, Number(process.env.NEAR_AI_COOLDOWN_MS || 6 * 60 * 60 * 1000));
  return { limit, cooldownMs, day: new Date(now).toISOString().slice(0, 10) };
}

export function aiUsage(now = Date.now()) {
  const { limit, day } = aiBudget(now);
  const row = db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE day = ? AND kind = 'page'").get(day);
  return { day, used: num(row?.n || 0), limit };
}

export function agentUsage(now = Date.now()) {
  const limit = Math.max(0, Number(process.env.NEAR_AI_AGENT_DAILY_LIMIT || 4));
  const day = new Date(now).toISOString().slice(0, 10);
  const row = db.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE day = ? AND kind = 'agent'").get(day);
  return { day, used: num(row?.n || 0), limit };
}

export function reserveAgentCall(now = Date.now()) {
  const limit = Math.max(0, Number(process.env.NEAR_AI_AGENT_DAILY_LIMIT || 4));
  const gap = Math.max(0, Number(process.env.NEAR_AI_AGENT_GAP_MS || 30 * 60 * 1000));
  const day = new Date(now).toISOString().slice(0, 10);
  const used = agentUsage(now).used;
  if (used >= limit) return { ok: false, reason: "daily", used, limit };
  const last = db.prepare("SELECT MAX(at) AS at FROM ai_calls WHERE kind = 'agent'").get();
  const lastAt = num(last?.at || 0);
  if (lastAt && now - lastAt < gap) return { ok: false, reason: "gap", used, limit };
  db.prepare("INSERT INTO ai_calls (day, market_id, at, kind) VALUES (?, ?, ?, 'agent')").run(day, "agent-draft", now);
  return { ok: true, used: used + 1, limit };
}

export function reserveAiCall(marketId, now = Date.now()) {
  const { limit, cooldownMs, day } = aiBudget(now);
  const used = aiUsage(now).used;
  if (used >= limit) return { ok: false, reason: "daily", used, limit };
  const last = db.prepare("SELECT MAX(at) AS at FROM ai_calls WHERE market_id = ?").get(marketId);
  const lastAt = num(last?.at || 0);
  if (lastAt && now - lastAt < cooldownMs) return { ok: false, reason: "cooldown", used, limit };
  db.prepare("INSERT INTO ai_calls (day, market_id, at, kind) VALUES (?, ?, ?, 'page')").run(day, marketId, now);
  return { ok: true, used: used + 1, limit };
}
