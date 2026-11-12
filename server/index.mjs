import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  clientView,
  connectAgent,
  finalize,
  openCounter,
  overrideResolution,
  proposeResolution,
  resetAccount,
  setLimit,
  setPerm,
  setSummary,
  withLedger,
} from "../engine/book.mjs";
import { draftThesis, readSource, writeConsensus, aiEnabled } from "./ai.mjs";
import { attachKnownSources, parseDraft, parseVerdict, publicSourceUrl, publishDraft } from "./agents.mjs";
import { loadFeeds } from "./feeds.mjs";
import { quoteUsdc } from "./intents.mjs";
import { keyPair, signAndSend } from "./near.mjs";
import { applyDeskPlan, step } from "./swarm.mjs";
import {
  confirmAgentKey,
  requireAccount,
  settleNear,
  syncBalance,
  takeDeposit,
  takeLockedBet,
  takeWithdraw,
  verifiedCall,
} from "./funds.mjs";
import {
  agentKey,
  agentUsage,
  claimNearTx,
  aiUsage,
  blankUser,
  insertUser,
  listUsers,
  loadBook,
  openStore,
  recentAccounts,
  reserveAgentCall,
  reserveAiCall,
  saveAgentKey,
  saveBook,
  saveUser,
  startSession,
  userByAccount,
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
if (attachKnownSources(book)) saveBook(book);
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
  ".mjs": "text/javascript; charset=utf-8",
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
        funds: "testnet-near",
        network: process.env.NEAR_NETWORK || "testnet",
        contract: process.env.PENCILS_CONTRACT || "pencilsbuzz.testnet",
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
    if (req.method === "POST" && url.pathname === "/api/login") {
      rateLimit(clientIp(req));
      const body = await readBody(req);
      const accountId = String(body.accountId || "").trim().toLowerCase();
      if (!/^[a-z0-9._-]{2,64}$/.test(accountId)) throw new Error("That NEAR account is not valid");
      const call = await verifiedCall(body.txHash, accountId);
      if (call.method !== "register") throw new Error("Sign the Pencils login");
      const result = await serial(async () => {
        const current = openAccount(req, res);
        const existing = userByAccount(accountId);
        const user = existing || current;
        user.accountId = accountId;
        await syncBalance(user);
        claimNearTx(body.txHash, accountId, "register");
        saveUser(user);
        if (existing && existing.id !== current.id) {
          const token = startSession(existing.id);
          const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
          res.setHeader("set-cookie", `pencils=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=34560000${secure}`);
        }
        return okView(user, { accountId });
      });
      return json(res, 200, result);
    }
    if (req.method === "POST" && (url.pathname === "/api/deposit" || url.pathname === "/api/withdraw")) {
      rateLimit(clientIp(req));
      const body = await readBody(req);
      const result = await serial(async () => {
        const user = openAccount(req, res);
        if (url.pathname === "/api/withdraw") await takeWithdraw(user, body.txHash);
        else await takeDeposit(user, body.txHash);
        saveUser(user);
        return okView(user, { balance: user.balance });
      });
      return json(res, 200, result);
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      rateLimit(clientIp(req));
      const body = await readBody(req);
      const result = await serial(async () => {
        const user = openAccount(req, res);
        const now = Date.now();
        if (url.pathname === "/api/bet" || url.pathname === "/api/stake") {
          requireAccount(user);
          const marketId = url.pathname === "/api/stake" ? body.marketId : body.marketId;
          const before = book.markets.find((m) => m.id === marketId)?.p ?? 0;
          const placed = await takeLockedBet(book, user, url.pathname === "/api/stake" ? { ...body, stake: true } : body);
          saveUser(user);
          saveBook(book);
          return { body: okView(user, placed), ai: { id: marketId, before } };
        }
        if (url.pathname === "/api/agents/confirm") {
          requireAccount(user);
          const agent = (user.agents || []).find((a) => a.id === body.id);
          if (!agent) throw new Error("Agent not found");
          await confirmAgentKey(user, agent);
          book.rev = (book.rev || 0) + 1;
          saveUser(user);
          saveBook(book);
          return { body: okView(user, { agent }), ai: null };
        }
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
          if (url.pathname === "/api/agents") {
            requireAccount(user);
            const agent = connectAgent(book, { name: body.name, kind: body.kind, watch: body.watch, parent: user.accountId, now });
            const keys = keyPair();
            agent.publicKey = keys.publicKey;
            saveAgentKey({
              agentId: agent.id,
              userId: user.id,
              accountId: user.accountId,
              publicKey: keys.publicKey,
              secretKey: keys.secretKey,
            });
            return { agent, publicKey: keys.publicKey };
          }
          if (url.pathname === "/api/agents/perm") {
            return { agent: setPerm(book, { id: body.id, perm: body.perm, on: body.on }) };
          }
          if (url.pathname === "/api/agents/limit") {
            return { agent: setLimit(book, { id: body.id, limit: body.limit }) };
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
          if (url.pathname === "/api/source") {
            requireAccount(user);
            const market = book.markets.find((m) => m.id === body.marketId);
            if (!market?.feedUrl) throw new Error("This market has no source to follow");
            const outcome = body.outcome === "no" ? "no" : body.outcome === "yes" ? "yes" : "";
            if (!outcome) throw new Error("Say whether the source shows Yes or No");
            proposeResolution(book, {
              marketId: market.id,
              outcome,
              evidence: `Reviewer checked ${market.feedUrl}`.slice(0, 280),
              now,
            });
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
  console.log(`Book is sqlite at ${dataFile}. Balances are testnet NEAR deposited to ${process.env.PENCILS_CONTRACT || "pencilsbuzz.testnet"}.`);
  console.log(`Desk reads X, Reddit, and the news${aiEnabled() ? " and quotes with NEAR AI" : ""}. Humans can take the other side. Intents quotes are dry.`);
});

setInterval(() => {
  serial(async () => {
    const users = listUsers();
    const before = new Map(users.map((u) => [u.id, JSON.stringify(u)]));
    book.ledgers = users;
    let actions = [];
    try {
      actions = step(book, Math.random, Date.now());
    } finally {
      delete book.ledgers;
    }
    let accounts = [];
    try {
      accounts = await settleNear(book);
    } catch (err) {
      console.error("NEAR settlement failed:", err.message);
    }
    if (actions.length || accounts.length) saveBook(book);
    for (const u of users) {
      if (JSON.stringify(u) !== before.get(u.id)) saveUser(u);
    }
    for (const accountId of accounts) {
      const user = listUsers().find((u) => u.accountId === accountId);
      if (!user) continue;
      try {
        await syncBalance(user);
        saveUser(user);
      } catch (err) {
        console.error("balance sync skipped:", err.message);
      }
    }
  }).catch((err) => console.error("swarm step failed:", err.message));
}, Number(process.env.SWARM_MS || 8000));

let hostBusy = false;

async function hostedRound() {
  if (hostBusy || !process.env.PENCILS_RELEASE_KEY) return;
  hostBusy = true;
  try {
    const plans = await serial(() => {
      const chosen = [];
      const seen = new Set();
      for (const user of listUsers()) {
        if (!user.accountId || !(Number(user.balance) >= 1) || seen.has(user.id)) continue;
        const agent = (user.agents || []).find((a) => a.live && a.perms?.trade && a.limit - a.spent >= 1);
        if (!agent) continue;
        const held = new Set((user.positions || []).filter((p) => p.via === agent.id).map((p) => p.mid));
        const market = book.markets.find(
          (m) => m.status === "open" && m.ends > Date.now() && !held.has(m.id) && (m.p >= 0.62 || m.p <= 0.38),
        );
        if (!market) continue;
        seen.add(user.id);
        chosen.push({
          userId: user.id,
          accountId: user.accountId,
          agentId: agent.id,
          marketId: market.id,
          side: market.p >= 0.62 ? "yes" : "no",
          amount: 1,
        });
      }
      return chosen.slice(0, 2);
    });
    for (const plan of plans) {
      try {
        const key = agentKey(plan.agentId);
        if (!key || key.account_id !== plan.accountId) continue;
        const micro = String(Math.round(plan.amount * 1e6));
        const txHash = await signAndSend({
          accountId: key.account_id,
          secretKey: key.secret_key,
          methodName: "lock",
          args: { amount: micro },
        });
        await serial(async () => {
          const user = listUsers().find((u) => u.id === plan.userId);
          if (!user) return;
          await takeLockedBet(book, user, { ...plan, via: plan.agentId, txHash });
          saveUser(user);
          saveBook(book);
        });
      } catch (err) {
        console.error("hosted agent skipped:", err.message);
      }
    }
  } finally {
    hostBusy = false;
  }
}

setTimeout(() => {
  hostedRound();
  setInterval(hostedRound, 60_000);
}, 45_000);

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
    console.log(`NEAR AI desk plan (${slot.used}/${slot.limit} today) from ${fresh.source}`);
    const text = await draftThesis({ title: fresh.text, source: fresh.source });
    const draft = parseDraft(text);
    if (!draft) throw new Error("draft was not JSON");
    await serial(() => {
      const users = listUsers();
      const created = publishDraft(book, users, draft, fresh, Date.now());
      const actions = applyDeskPlan(
        book,
        { marketId: created.id, quote: draft.quote, deepen: draft.deepen, counter: draft.counter },
        Date.now(),
      );
      saveBook(book);
      for (const user of users) {
        if ((user.agents || []).some((a) => a.id === created.by)) saveUser(user);
      }
      console.log(`Desk published ${created.id} as ${created.by}; ${actions.join(" | ") || "no quote"}`);
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

const bootAt = Date.now();
let quorumBusy = false;
let quorumUsed = false;

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function readPage(url) {
  const res = await fetch(`https://r.jina.ai/${url}`, {
    headers: { accept: "text/plain" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`source ${res.status}`);
  const text = await res.text();
  return text.replace(/\s+/g, " ").trim().slice(0, 3500);
}

// One source read per process, and never in the first 45 minutes after boot.
async function quorumRound() {
  if (quorumBusy || quorumUsed || !aiEnabled()) return;
  if (Date.now() - bootAt < 45 * 60 * 1000) return;
  quorumBusy = true;
  try {
    const market = book.markets.find((m) => m.status === "open" && m.ends <= Date.now() && publicSourceUrl(m.feedUrl));
    if (!market) return;
    const url = publicSourceUrl(market.feedUrl);
    let page = "";
    try {
      page = await readPage(url);
    } catch (err) {
      console.error("quorum source unread:", err.message);
      return;
    }
    if (page.length < 40) return;
    const slot = reserveAiCall(`quorum:${market.id}`);
    if (!slot.ok) return;
    quorumUsed = true;
    console.log(`NEAR AI source read (${slot.used}/${slot.limit} today) for ${market.id}`);
    const text = await readSource({
      title: String(market.t || "").replace(/\[\[|\]\]/g, ""),
      criteria: market.crit,
      page,
    });
    const outcome = parseVerdict(text);
    await serial(() => {
      if (outcome === "yes" || outcome === "no") {
        proposeResolution(book, {
          marketId: market.id,
          outcome,
          evidence: `Quorum read ${url}. The trade price is not the result.`.slice(0, 280),
          now: Date.now(),
        });
        console.log(`Quorum proposed ${outcome} on ${market.id}`);
      } else {
        market.awaitingSource = true;
        book.events.unshift({
          html: `<b>Quorum</b> read the source for “${escHtml(String(market.t || "").replace(/\[\[|\]\]/g, "").slice(0, 56))}” and is not sure yet`,
          t: Date.now(),
        });
        book.events = book.events.slice(0, 30);
        book.rev += 1;
        console.log(`Quorum left ${market.id} open`);
      }
      saveBook(book);
    });
  } catch (err) {
    console.error("quorum round skipped:", err.message);
  } finally {
    quorumBusy = false;
  }
}

setTimeout(() => {
  quorumRound();
  setInterval(quorumRound, 30 * 60 * 1000);
}, 45 * 60 * 1000);

process.on("SIGTERM", () => {
  try {
    saveBook(book);
  } catch (err) {
    console.error("shutdown save failed:", err.message);
  }
  process.exit(0);
});
