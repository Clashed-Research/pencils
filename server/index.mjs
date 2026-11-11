import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  bet,
  clientView,
  connectAgent,
  deposit,
  finalize,
  openCounter,
  overrideResolution,
  resetAccount,
  setLimit,
  setPerm,
  setSummary,
  stake,
  withdraw,
  withLedger,
} from "../engine/book.mjs";
import { draftThesis, writeConsensus, aiEnabled } from "./ai.mjs";
import { parseDraft, publishDraft } from "./agents.mjs";
import { loadFeeds } from "./feeds.mjs";
import { quoteUsdc } from "./intents.mjs";
import { step } from "./swarm.mjs";
import {
  agentUsage,
  aiUsage,
  blankUser,
  insertUser,
  listUsers,
  loadBook,
  openStore,
  recentAccounts,
  reserveAgentCall,
  reserveAiCall,
  saveBook,
  saveUser,
  startSession,
  userByToken,
  userCount,
} from "./store.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "web");
const dataFile = process.env.PENCILS_DATA || path.join(root, "data", "pencils.sqlite");
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "0.0.0.0";

openStore(dataFile);
let book = loadBook();
let queue = Promise.resolve();

function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.then(
    () => {},
    () => {},
  );
  return run;
}

let aiInFlight = false;
let aiDailyLogged = "";

function maybeRewrite(id, before) {
  if (!aiEnabled() || aiInFlight) return;
  const m = book.markets.find((x) => x.id === id);
  if (!m) return;
  if (Math.abs(m.p - before) < 0.03) return;
  const slot = reserveAiCall(id);
  if (!slot.ok) {
    if (slot.reason === "daily" && aiDailyLogged !== slot.used + ":" + slot.limit) {
      aiDailyLogged = slot.used + ":" + slot.limit;
      console.error(`NEAR AI stopped for today (${slot.used}/${slot.limit})`);
    }
    return;
  }
  aiInFlight = true;
  console.log(`NEAR AI page ${id} (${slot.used}/${slot.limit} today)`);
  const title = m.t.replace(/\[\[|\]\]/g, "");
  const probability = Math.round(m.p * 100);
  const criteria = m.crit;
  writeConsensus({ title, probability, criteria })
    .then((text) => {
      if (!text) return;
      return serial(() => {
        setSummary(book, id, text);
        saveBook(book);
      });
    })
    .catch((err) => {
      console.error("NEAR AI summary skipped:", err.message);
    })
    .finally(() => {
      aiInFlight = false;
    });
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 100_000) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function clientIp(req) {
  const peer = String(req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  const local = peer === "127.0.0.1" || peer === "::1";
  if (local) {
    const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    if (fwd) return fwd.slice(0, 64);
  }
  return peer || "unknown";
}

function sessionToken(req) {
  const raw = String(req.headers.cookie || "");
  const match = raw.match(/(?:^|;\s*)pencils=([a-f0-9]{64})/);
  return match ? match[1] : "";
}

const writes = new Map();

function rateLimit(ip) {
  const now = Date.now();
  const row = writes.get(ip) || { n: 0, t: now };
  if (now - row.t > 10000) {
    row.n = 0;
    row.t = now;
  }
  row.n += 1;
  writes.set(ip, row);
  if (row.n > 40) {
    throw Object.assign(new Error("Slow down"), { status: 429 });
  }
}

function openAccount(req, res) {
  const ip = clientIp(req);
  const existing = userByToken(sessionToken(req));
  if (existing) return existing;
  if (recentAccounts(ip, Date.now() - 86400000) >= 8) {
    throw Object.assign(new Error("Too many new accounts from this network today"), { status: 429 });
  }
  const user = blankUser();
  insertUser(user, ip);
  const token = startSession(user.id);
  const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  res.setHeader("set-cookie", `pencils=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000${secure}`);
  return user;
}

function okView(user, extra = {}) {
  const state = withLedger(book, user, () => clientView(book));
  return { ok: true, ...extra, state };
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/api/health") {
      return json(res, 200, {
        ok: true,
        service: "pencils",
        markets: book.markets.length,
        accounts: userCount(),
        store: "sqlite",
        ai: aiEnabled() ? "near-ai" : "scripted",
        aiTee: aiEnabled() ? "gateway" : null,
        aiBudget: aiEnabled() ? aiUsage() : null,
        agentBudget: aiEnabled() ? agentUsage() : null,
        feeds: (book.feeds || []).length,
        intents: "dry",
        funds: "house-credit",
        contract: process.env.PENCILS_CONTRACT || "pencils.testnet",
      });
    }
    if (url.pathname === "/api/quote" && req.method === "GET") {
      const amount = Number(url.searchParams.get("amount") || 0);
      const chain = url.searchParams.get("chain") || "eth";
      const direction = url.searchParams.get("direction") || "deposit";
      const quote = await quoteUsdc({ amountUsd: amount, chain, direction });
      return json(res, 200, { ok: true, quote });
    }
    if (url.pathname === "/api/state" && req.method === "GET") {
      const user = await serial(() => openAccount(req, res));
      return json(res, 200, withLedger(book, user, () => clientView(book)));
    }
    if (req.method === "POST" && (url.pathname === "/api/deposit" || url.pathname === "/api/withdraw")) {
      rateLimit(clientIp(req));
      const body = await readBody(req);
      const direction = url.pathname === "/api/withdraw" ? "withdraw" : "deposit";
      let quote = null;
      let quoteError = null;
      try {
        quote = await quoteUsdc({ amountUsd: body.amount, chain: body.chain || "eth", direction });
      } catch (err) {
        quoteError = err.message;
      }
      const result = await serial(() => {
        const user = openAccount(req, res);
        const payload = withLedger(book, user, () => {
          const usd = Math.round(Number(body.amount) * 100) / 100;
          if (direction === "deposit" && book.balance + usd > 1000) {
            throw new Error("Demo credit stays at or under $1,000");
          }
          const balance = direction === "withdraw" ? withdraw(book, body.amount) : deposit(book, body.amount);
          return { balance, quote, quoteError };
        });
        saveUser(user);
        saveBook(book);
        return okView(user, payload);
      });
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      rateLimit(clientIp(req));
      const body = await readBody(req);
      const result = await serial(() => {
        const user = openAccount(req, res);
        const now = Date.now();
        if (url.pathname === "/api/finalize") {
          const users = listUsers();
          const mine = users.findIndex((u) => u.id === user.id);
          if (mine >= 0) users[mine] = user;
          book.ledgers = users;
          try {
            finalize(book, { marketId: body.marketId, now });
          } finally {
            delete book.ledgers;
          }
          for (const u of users) saveUser(u);
          saveBook(book);
          return { body: okView(user, {}), ai: null };
        }
        let ai = null;
        const payload = withLedger(book, user, () => {
          if (url.pathname === "/api/bet") {
            const before = book.markets.find((m) => m.id === body.marketId)?.p ?? 0;
            const fill = bet(book, { marketId: body.marketId, side: body.side, amount: body.amount, via: body.via || "me", now });
            ai = { id: body.marketId, before };
            return { fill };
          }
          if (url.pathname === "/api/agents") {
            return { agent: connectAgent(book, { name: body.name, kind: body.kind, watch: body.watch, now }) };
          }
          if (url.pathname === "/api/agents/perm") {
            return { agent: setPerm(book, { id: body.id, perm: body.perm, on: body.on }) };
          }
          if (url.pathname === "/api/agents/limit") {
            return { agent: setLimit(book, { id: body.id, limit: body.limit }) };
          }
          if (url.pathname === "/api/stake") {
            const before = book.markets.find((m) => m.id === body.marketId)?.p ?? 0;
            stake(book, { marketId: body.marketId, agentId: body.agentId, amount: body.amount, now });
            ai = { id: body.marketId, before };
            return {};
          }
          if (url.pathname === "/api/counter") {
            if (!body.agentId || !book.agents.some((a) => a.id === body.agentId)) {
              throw new Error("Only your agent can open a market");
            }
            return { opened: openCounter(book, { marketId: body.marketId, agentId: body.agentId, now }) };
          }
          if (url.pathname === "/api/markets") {
            throw new Error("Only an agent can publish a thesis. Host one and it will read the live feed. You can still bet.");
          }
          if (url.pathname === "/api/override") {
            const updated = overrideResolution(book, { marketId: body.marketId, outcome: body.outcome, now });
            updated.overrideBy = user.id;
            return {};
          }
          if (url.pathname === "/api/reset") {
            return { reset: true };
          }
          const err = new Error("Not found");
          err.status = 404;
          throw err;
        });
        if (payload.reset) resetAccount(user, now);
        saveUser(user);
        saveBook(book);
        const pub = { ...payload };
        delete pub.reset;
        return { body: okView(user, pub), ai };
      });
      if (result?.ai) maybeRewrite(result.ai.id, result.ai.before);
      return json(res, 200, result.body);
    }
    const rel = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "") || "index.html";
    if (rel.includes("\0")) return json(res, 400, { error: "Bad path" });
    const base = path.resolve(web);
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) return json(res, 403, { error: "Forbidden" });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: "Not found" });
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": TYPES[ext] || "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    if (res.headersSent) return;
    json(res, err.status || 400, { error: err.message || "Request failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Pencils is live at http://${host}:${port}`);
  console.log(`Book is sqlite at ${dataFile}. Each browser has its own $250 house credit.`);
  console.log(`Swarm reads X, Reddit, and the news${aiEnabled() ? " and drafts with NEAR AI" : ""}. Humans bet. Intents quotes are dry.`);
});

setInterval(() => {
  serial(() => {
    const users = listUsers();
    const before = new Map(users.map((u) => [u.id, JSON.stringify(u)]));
    book.ledgers = users;
    let actions = [];
    try {
      actions = step(book, Math.random, Date.now());
    } finally {
      delete book.ledgers;
    }
    if (actions.length) saveBook(book);
    for (const u of users) {
      if (JSON.stringify(u) !== before.get(u.id)) saveUser(u);
    }
  }).catch((err) => console.error("swarm step failed:", err.message));
}, Number(process.env.SWARM_MS || 8000));

let agentBusy = false;
let agentCapLogged = false;

async function agentRound() {
  if (agentBusy) return;
  agentBusy = true;
  try {
    const posts = await loadFeeds();
    if (!posts.length) return;
    await serial(() => {
      const next = posts.slice(0, 8).map((p) => ({
        id: p.id,
        source: p.source,
        title: p.title.slice(0, 180),
        url: p.url,
      }));
      if (JSON.stringify(book.feeds || []) !== JSON.stringify(next)) {
        book.feeds = next;
        saveBook(book);
      }
    });
    if (!aiEnabled()) return;
    const seen = new Set(book.seenFeeds || []);
    const fresh = posts.find((p) => !seen.has(p.id));
    if (!fresh) return;
    const slot = reserveAgentCall();
    if (!slot.ok) {
      if (slot.reason === "daily" && !agentCapLogged) {
        agentCapLogged = true;
        console.error(`Agent drafts stopped for today (${slot.used}/${slot.limit})`);
      }
      return;
    }
    console.log(`NEAR AI agent draft (${slot.used}/${slot.limit} today) from ${fresh.source}`);
    const text = await draftThesis({ title: fresh.text, source: fresh.source });
    const draft = parseDraft(text);
    if (!draft) throw new Error("draft was not JSON");
    await serial(() => {
      const users = listUsers();
      const created = publishDraft(book, users, draft, fresh, Date.now());
      saveBook(book);
      for (const user of users) {
        if ((user.agents || []).some((a) => a.id === created.by)) saveUser(user);
      }
      console.log(`Agent published ${created.id} as ${created.by}`);
    });
  } catch (err) {
    console.error("agent round skipped:", err.message);
  } finally {
    agentBusy = false;
  }
}

const agentMs = Math.max(60_000, Number(process.env.AGENT_MS || 180000));
setTimeout(() => {
  agentRound();
  setInterval(agentRound, agentMs);
}, 20_000);

process.on("SIGTERM", () => {
  try {
    saveBook(book);
  } catch (err) {
    console.error("shutdown save failed:", err.message);
  }
  process.exit(0);
});
