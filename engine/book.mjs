import { repeatsClaim } from "./claims.mjs";
import { addBoth, applyBuy, commitPool, freshPool, leanQuote, microToUsd, seedTo, spot, usdToMicro } from "./math.mjs";
import { DRAFTS, RESOLVED, seedMarkets, SYSTEM } from "./seed.mjs";

const DAY = 86400000;
const CHALLENGE_MS = DAY;

function hash(s) {
  let h = 7;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v));
}
export function genHist(id, end, n = 200) {
  const r = rng(hash(id));
  let p = 0.5 + (r() - 0.5) * 0.35;
  const a = [];
  for (let i = 0; i < n; i++) {
    p += (r() - 0.5) * 0.03 + (r() < 0.02 ? (r() - 0.5) * 0.08 : 0);
    p = clamp(p, 0.04, 0.96);
    a.push(p);
  }
  const sh = end - a[n - 1];
  return a.map((v) => clamp(v + sh, 0.02, 0.98));
}

function poolFromTarget(target) {
  const pool = freshPool();
  seedTo(pool, target);
  return pool;
}

function attachPool(m) {
  const pool = poolFromTarget(m.p);
  m.pool = serPool(pool);
  m.p = spot(pool.yes, pool.no);
  m.hist = genHist(m.id, m.p);
  m.trades = seedTrades(m);
  m.status = "open";
  m.outcome = null;
  m.proposedAt = null;
  m.evidence = "";
  m.coalitionShares = {};
  m.feeAgent = "0";
  m.feePencils = "0";
  if (!m.narrative) m.narrative = "";
  if (!m.role) m.role = "";
  if (!m.ct) m.ct = null;
  return m;
}

function serPool(pool) {
  return {
    yes: pool.yes.toString(),
    no: pool.no.toString(),
    collateral: pool.collateral.toString(),
    yesLiab: pool.yesLiab.toString(),
    noLiab: pool.noLiab.toString(),
    fees: pool.fees.toString(),
  };
}
function dePool(s) {
  return {
    yes: BigInt(s.yes),
    no: BigInt(s.no),
    collateral: BigInt(s.collateral),
    yesLiab: BigInt(s.yesLiab),
    noLiab: BigInt(s.noLiab),
    fees: BigInt(s.fees),
  };
}

function seedTrades(m) {
  const r = rng(hash(m.id + "t"));
  const who = ["pulse", "ledger", "contra", "h:ade.near", "h:kemi.near", "h:tobi.near", "h:mira.near"];
  const now = Date.now();
  return Array.from({ length: 5 }, (_, i) => {
    const w = who[Math.floor(r() * who.length)];
    return {
      who: w,
      side: r() < m.p ? "yes" : "no",
      amt: Math.round(5 + r() * 240),
      t: now - (i + 1) * Math.round(2 + r() * 9) * 60000,
    };
  });
}

export function createState(now = Date.now()) {
  const markets = seedMarkets(now).map((m) => attachPool({ ...m, co: m.co.map((c) => [...c]) }));
  const banks = {};
  for (const a of Object.values(SYSTEM)) banks[a.id] = a.bank;
  return {
    schema: 1,
    rev: 1,
    now,
    balance: 250,
    positions: [],
    agents: [],
    notif: { ending: true, proposed: true, coalition: true, resolved: true },
    markets,
    events: [{ html: "<b>Pulse</b> is scanning 1,284 posts a minute", t: now }],
    resolved: RESOLVED.map((r) => ({ ...r })),
    banks,
    drafts: DRAFTS.map((d) => ({ ...d })),
    userMarketSeq: 0,
    fees: { pencils: "0", byAgent: {} },
  };
}

function bump(state) {
  state.rev += 1;
}

export function market(state, id) {
  const m = state.markets.find((x) => x.id === id);
  if (!m) throw new Error("Market not found");
  return m;
}

function live(state, now) {
  return state.markets.filter((m) => m.status === "open" && m.ends > now);
}

function pushEvent(state, html, now) {
  state.events.unshift({ html, t: now });
  state.events = state.events.slice(0, 30);
}

function recordActivity(state, { kind, agentId = "", name = "", marketId = "", text = "", now = Date.now() }) {
  state.activity = state.activity || [];
  state.activity.unshift({
    id: `${kind}-${now.toString(36)}-${state.activity.length}`,
    t: now,
    kind: String(kind || "note").slice(0, 24),
    agentId: String(agentId || "").slice(0, 40),
    name: String(name || "").slice(0, 40),
    marketId: String(marketId || "").slice(0, 40),
    text: String(text || "").replace(/\s+/g, " ").trim().slice(0, 180),
  });
  state.activity = state.activity.slice(0, 80);
}

function plain(t) {
  return t.replace(/\[\[|\]\]/g, "");
}
function short(t) {
  const p = plain(t);
  return p.length > 58 ? p.slice(0, 56).replace(/\s+\S*$/, "") + "…" : p;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function agentName(state, id) {
  if (id === "you" || id === "me") return "You";
  if (SYSTEM[id]) return SYSTEM[id].name;
  const a = state.agents.find((x) => x.id === id);
  return a ? a.name : id;
}

function spend(state, who, usd, opts = {}) {
  if (opts.prepaid) {
    if (who !== "me" && who !== "you" && !SYSTEM[who]) {
      const a = state.agents.find((x) => x.id === who);
      if (!a) throw new Error("Unknown agent");
      if (opts.limit !== false) {
        if (!a.perms.trade) throw new Error(`${a.name} cannot trade`);
        if (usd > a.limit - a.spent + 1e-9) throw new Error("Over agent spending limit");
        a.spent = round2(a.spent + usd);
      }
    }
    return;
  }
  if (who === "me" || who === "you") {
    if (usd > state.balance + 1e-9) throw new Error("Not enough balance");
    state.balance = round2(state.balance - usd);
    return;
  }
  if (SYSTEM[who]) {
    if (usd > state.banks[who] + 1e-9) throw new Error(`${SYSTEM[who].name} is out of budget`);
    state.banks[who] = round2(state.banks[who] - usd);
    return;
  }
  const a = state.agents.find((x) => x.id === who);
  if (!a) throw new Error("Unknown agent");
  if (opts.limit !== false) {
    if (!a.perms.trade) throw new Error(`${a.name} cannot trade`);
    if (usd > a.limit - a.spent + 1e-9) throw new Error("Over agent spending limit");
    a.spent = round2(a.spent + usd);
  }
  if (usd > state.balance + 1e-9) throw new Error("Not enough balance");
  state.balance = round2(state.balance - usd);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function microString(value) {
  try {
    const n = BigInt(value ?? "0");
    return n < 0n ? "0" : n.toString();
  } catch {
    return "0";
  }
}

function feeBook(state) {
  const prev = state.fees && typeof state.fees === "object" ? state.fees : {};
  const byAgent = prev.byAgent && typeof prev.byAgent === "object" ? prev.byAgent : {};
  state.fees = { pencils: microString(prev.pencils), byAgent };
  return state.fees;
}

// A fill's fee is book credit: half for the agent that listed the market, half for Pencils.
// It is not added to a balance, so it cannot be refunded as NEAR. finalize pays a coalition
// only the pool fees this split did not claim (seed quotes and two-sided liquidity).
function creditTradeFee(state, m, feeMicro) {
  if (feeMicro <= 0n) return;
  const agentPart = feeMicro / 2n;
  const pencilsPart = feeMicro - agentPart;
  m.feeAgent = (BigInt(microString(m.feeAgent)) + agentPart).toString();
  m.feePencils = (BigInt(microString(m.feePencils)) + pencilsPart).toString();
  const fees = feeBook(state);
  const who = m.by || "unknown";
  fees.byAgent[who] = (BigInt(microString(fees.byAgent[who])) + agentPart).toString();
  fees.pencils = (BigInt(fees.pencils) + pencilsPart).toString();
}

function tradeInto(state, m, side, usd, who, now, { position = true, coalition = false, limit = true, near = false, prepaid = false } = {}) {
  if (m.status !== "open") throw new Error("Market is not open");
  if (m.ends <= now) throw new Error("Market is closed");
  const budget = usdToMicro(usd);
  const pool = dePool(m.pool);
  let next;
  try {
    next = applyBuy(pool.yes, pool.no, budget, side);
  } catch (err) {
    throw new Error(err.message === "Not enough liquidity" ? "Not enough liquidity for that size" : err.message);
  }
  spend(state, who, usd, { limit, prepaid });
  commitPool(pool, side, budget);
  m.pool = serPool(pool);
  const priceBefore = m.p;
  m.p = spot(pool.yes, pool.no);
  m.hist.push(m.p);
  if (m.hist.length > 200) m.hist.shift();
  m.vol = round2(m.vol + usd);
  m.traders += 1;
  const shares = microToUsd(next.shares);
  const price = side === "yes" ? priceBefore : 1 - priceBefore;
  const human = state.accountId ? `h:${state.accountId}` : "h:you.near";
  m.trades.unshift({ who: who === "me" ? human : who, side, amt: round2(usd), t: now });
  m.trades = m.trades.slice(0, 24);
  if (near && (who === "me" || state.agents.some((a) => a.id === who))) {
    const micro = Number(usdToMicro(usd));
    if (side === "yes") m.realYes = (m.realYes || 0) + micro;
    else m.realNo = (m.realNo || 0) + micro;
  }
  if (position && (who === "me" || state.agents.some((a) => a.id === who))) {
    state.positions.unshift({
      id: "p" + now.toString(36) + who.slice(0, 3),
      mid: m.id,
      side,
      shares,
      cost: round2(usd),
      via: who,
      t: now,
      near: !!near,
    });
  }
  if (coalition) {
    const prev = m.coalitionShares[who] || { usd: 0, shares: 0 };
    m.coalitionShares[who] = { usd: round2(prev.usd + usd), shares: prev.shares + shares };
    const row = m.co.find((c) => c[0] === who);
    if (row) row[1] = round2(row[1] + usd);
    else m.co.push([who, round2(usd)]);
  }
  creditTradeFee(state, m, next.fee);
  return { shares, price: side === "yes" ? priceBefore : 1 - priceBefore, p: m.p, fee: microToUsd(next.fee) };
}

export function bet(state, { marketId, side, amount, via = "me", now = Date.now(), near = false, prepaid = false }) {
  const m = market(state, marketId);
  const usd = round2(Number(amount));
  if (!(usd > 0)) throw new Error("Amount must be positive");
  const who = via === "me" ? "me" : via;
  if (who !== "me") {
    const a = state.agents.find((x) => x.id === who);
    if (!a) throw new Error("Connect that agent first");
    if (!a.perms.trade) throw new Error(`${a.name} is not allowed to trade`);
  }
  const fill = tradeInto(state, m, side, usd, who, now, { position: true, near, prepaid });
  const label = who === "me" ? "You" : agentName(state, who);
  pushEvent(state, `<b>${esc(label)}</b> bought ${side === "yes" ? "Yes" : "No"} on “${esc(short(m.t))}”`, now);
  bump(state);
  return fill;
}

export function swarmTrade(state, { marketId, side, amount, agentId, now = Date.now() }) {
  if (!SYSTEM[agentId]) throw new Error("Not a swarm agent");
  const m = market(state, marketId);
  const usd = round2(Number(amount));
  const fill = tradeInto(state, m, side, usd, agentId, now, { position: false });
  pushEvent(
    state,
    `<b>${esc(SYSTEM[agentId].name)}</b> bought ${side === "yes" ? "Yes" : "No"} on “${esc(short(m.t))}”`,
    now,
  );
  bump(state);
  return fill;
}

// Ledger's standing quote. Inventory stays on the book: no position, no NEAR.
export function quoteToward(state, { marketId, target, maxUsd, now = Date.now() }) {
  const m = market(state, marketId);
  if (m.status !== "open") throw new Error("Market is not open");
  if (m.ends <= now) throw new Error("Market is closed");
  const cap = round2(Number(maxUsd));
  if (!(cap >= 1)) throw new Error("Amount must be positive");
  const pool = dePool(m.pool);
  const before = m.p;
  const spentMicro = leanQuote(pool, target, usdToMicro(cap));
  const spent = round2(microToUsd(spentMicro));
  if (spent < 1) return { spent: 0, p: m.p, before };
  spend(state, "ledger", spent);
  m.pool = serPool(pool);
  m.p = spot(pool.yes, pool.no);
  m.hist.push(m.p);
  if (m.hist.length > 200) m.hist.shift();
  m.vol = round2(m.vol + spent);
  m.trades.unshift({ who: "ledger", side: target >= before ? "yes" : "no", amt: spent, t: now });
  m.trades = m.trades.slice(0, 24);
  const pct = Math.round(m.p * 100);
  pushEvent(state, `<b>Ledger</b> quoted “${esc(short(m.t))}” at ${pct}%. Book liquidity stays on the book.`, now);
  bump(state);
  return { spent, p: m.p, before };
}

// Two-sided depth. Equal collateral on Yes and No. No shares, no NEAR.
export function provideLiquidity(state, { marketId, amount, now = Date.now() }) {
  const m = market(state, marketId);
  if (m.status !== "open") throw new Error("Market is not open");
  if (m.ends <= now) throw new Error("Market is closed");
  const usd = round2(Number(amount));
  if (![20, 40, 80].includes(usd)) throw new Error("Liquidity is 20, 40, or 80");
  const pool = dePool(m.pool);
  spend(state, "ledger", usd);
  addBoth(pool, usdToMicro(usd));
  m.pool = serPool(pool);
  const before = m.p;
  m.p = spot(pool.yes, pool.no);
  m.hist.push(m.p);
  if (m.hist.length > 200) m.hist.shift();
  pushEvent(
    state,
    `<b>Ledger</b> stood $${usd.toFixed(0)} behind both sides of “${esc(short(m.t))}”. Book liquidity, not withdrawable NEAR.`,
    now,
  );
  bump(state);
  return { p: m.p, before, depth: usd };
}

export function connectAgent(state, { name, kind = "near", watch = "", parent = "", now = Date.now() }) {
  const clean = String(name || "").trim().slice(0, 24) || ["Night Owl", "Macro Scout", "Signal Fox", "Drift"][state.agents.length % 4];
  const n = state.agents.length + 1;
  const a = {
    id: "ua" + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    name: clean,
    handle: parent ? `agent-${n}.${parent}` : `agent-${n}.pencilsbuzz.testnet`,
    kind: kind === "api" || kind === "external" ? kind : "near",
    glyph: ["ring", "plus", "bars", "half"][(n - 1) % 4],
    watch: String(watch || "").trim().slice(0, 80),
    perms: { propose: true, trade: false },
    limit: 50,
    spent: 0,
    created: now,
    live: false,
    publicKey: "",
    policy: {
      contract: process.env.PENCILS_CONTRACT || "pencilsbuzz.testnet",
      methodNames: ["lock"],
      allowanceNear: "0.3",
    },
  };
  state.agents.push(a);
  pushEvent(state, `<b>${esc(clean)}</b> plugged in as ${esc(a.handle)}`, now);
  recordActivity(state, { kind: "plugged", agentId: a.id, name: clean, text: `${clean} plugged in`, now });
  bump(state);
  return a;
}

export function setPerm(state, { id, perm, on }) {
  const a = state.agents.find((x) => x.id === id);
  if (!a) throw new Error("Agent not found");
  if (perm !== "propose" && perm !== "trade") throw new Error("Unknown permission");
  a.perms[perm] = !!on;
  bump(state);
  return a;
}

export function setLimit(state, { id, limit }) {
  const a = state.agents.find((x) => x.id === id);
  if (!a) throw new Error("Agent not found");
  const n = Math.max(0, Math.min(500, Math.round(Number(limit) / 10) * 10));
  a.limit = n;
  bump(state);
  return a;
}

export function stake(state, { marketId, agentId, amount, now = Date.now(), near = false, prepaid = false }) {
  const m = market(state, marketId);
  const a = state.agents.find((x) => x.id === agentId);
  const system = SYSTEM[agentId];
  if (!a && !system) throw new Error("Pick an agent to stake with");
  const usd = round2(Number(amount));
  if (!(usd > 0)) throw new Error("Stake must be positive");
  if (!system && near && ![1, 2, 5, 10].includes(usd)) throw new Error("Stake 1, 2, 5, or 10 NEAR");
  if (!system && !near && ![10, 25, 50].includes(usd)) throw new Error("Stake 10, 25, or 50 dollars");
  tradeInto(state, m, "yes", usd, agentId, now, { position: !!near, coalition: true, limit: false, near, prepaid });
  const label = agentName(state, agentId);
  pushEvent(state, `<b>${esc(label)}</b> joined the coalition on “${esc(short(m.t))}”`, now);
  bump(state);
  return m;
}

export function openCounter(state, { marketId, agentId, now = Date.now() }) {
  const m = market(state, marketId);
  if (m.counterOf) return { goto: m.counterOf, created: false };
  if (m.counter) return { goto: m.counter, created: false };
  const known = agentId && (SYSTEM[agentId] || state.agents.some((a) => a.id === agentId));
  if (!known) throw new Error("Only an agent can open a market");
  const by = agentId;
  const id = "c" + now.toString(36);
  const title = m.ct || `This does not happen: ${plain(m.t).replace(/\.$/, "")} [[as stated]].`;
  const target = clamp(1 - m.p, 0.05, 0.95);
  const c = attachPool({
    id,
    t: title,
    p: target,
    vol: 0,
    ends: m.ends,
    src: m.src?.[1] ? [m.src[0] || "agent", m.src[1]] : ["agent", `Counter-market opened by ${agentName(state, by)}`],
    feedUrl: m.feedUrl || "",
    by,
    co: [[by, 0]],
    counterOf: m.id,
    traders: 1,
    created: now,
    sum: "A fresh counter-market at {p}%. Early prices mirror the original thesis and will diverge as traders take sides.",
    crit: `Resolves Yes if the original thesis (“${plain(m.t)}”) resolves No. Quorum uses the same source${m.feedUrl ? `: ${m.feedUrl}` : m.src?.[1] ? ` (${m.src[1]})` : ""}.`,
    ct: null,
  });
  m.counter = id;
  state.markets.push(c);
  pushEvent(state, `<b>${esc(agentName(state, by))}</b> opened a counter-market on “${esc(short(m.t))}”`, now);
  bump(state);
  return { goto: id, created: true };
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString().slice(0, 200);
  } catch {
    return "";
  }
}

export function hasSource(market) {
  return Boolean(market?.src?.[1] && String(market.src[1]).trim().length > 3);
}

const CHECKS = [
  ["A number to measure", (v) => /\d|%|\$/.test(v)],
  ["A clear deadline", (v) => /(within|by |before|until|end of|this week|next week|tomorrow|today|in \d+|q[1-4]|20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(v)],
  ["A source to check", (v) => /(on x|price|volume|chart|leaderboard|index|report|data|close|trend|supply|announce|release|launch|poll|sales|tvl|users|transaction)/i.test(v)],
  ["One sentence, under 180", (v) => v.length >= 30 && v.length <= 180],
];

export function scoreThesis(text) {
  const v = String(text || "").trim();
  const checks = CHECKS.map(([label, fn]) => ({ label, ok: fn(v) }));
  return { checks, score: checks.filter((c) => c.ok).length, ok: checks.filter((c) => c.ok).length >= 3 };
}

export function propose(state, { title, days = 7, by, now = Date.now(), source, narrative = "", role = "" }) {
  const v = String(title || "").trim();
  const scored = scoreThesis(v);
  if (!scored.ok) throw new Error("Quorum rejected this thesis. It needs a number, a deadline, and a source.");
  if (!by || by === "you" || by === "me") throw new Error("Only an agent can publish a thesis. You can still bet.");
  const a = state.agents.find((x) => x.id === by) || SYSTEM[by];
  if (!a) throw new Error("Unknown proposer");
  if (a.perms && !a.perms.propose) throw new Error("That agent cannot propose");
  const len = [1, 7, 30].includes(Number(days)) ? Number(days) : 7;
  const id = "u" + now.toString(36);
  const t = v.includes("[[") ? v : v.replace(/(\d[\d,.]*\s?(%|k|m|b|\$)?\+?)/i, "[[$1]]");
  const label = String(source?.src?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const url = safeHttpUrl(source?.url);
  const where = label || "the public source named in the thesis";
  const cleanRole = role === "narrative" || role === "thesis" ? role : "";
  const line = String(narrative || "").replace(/\s+/g, " ").replaceAll("{p}", "").trim().slice(0, 160);
  const repeat = (state.markets || []).find((existing) => repeatsClaim(plain(existing.t), existing.narrative, v, line));
  if (repeat) throw new Error("That repeats a market already on the book");
  const m = attachPool({
    id,
    t,
    p: 0.5,
    vol: 0,
    ends: now + len * DAY,
    src: source?.src || ["agent", `Proposed by ${agentName(state, by)}`],
    feedUrl: url,
    by,
    co: [[by, 0]],
    traders: 1,
    created: now,
    narrative: line,
    role: cleanRole,
    sum: line
      ? `${line} Desk quote {p}%.`
      : "Just listed at {p}%. Agents are gathering signals and the first trades will set the price.",
    crit: `Resolves Yes if this claim is true by the deadline. Quorum checks ${where}${url ? ` (${url})` : ""}. The trade price is not the result.`,
    ct: null,
  });
  m.hist = m.hist.map(() => m.p);
  state.markets.push(m);
  const who = agentName(state, by);
  const listed = cleanRole === "narrative" ? "a narrative market" : cleanRole === "thesis" ? "a thesis market" : "a market";
  pushEvent(state, `<b>${esc(who)}</b> proposed “${esc(short(t))}”`, now);
  recordActivity(state, { kind: "launched", agentId: by, name: who, marketId: id, text: `${who} launched ${listed}`, now });
  if (url) {
    recordActivity(state, {
      kind: "approved",
      agentId: by,
      name: who,
      marketId: id,
      text: `${who} listed a sourced market`,
      now: now + 1,
    });
  }
  bump(state);
  return m;
}

export function deposit(state, amount) {
  const usd = round2(Number(amount));
  if (!(usd > 0)) throw new Error("Amount must be positive");
  if (usd > 100000) throw new Error("Demo deposits are capped at $100,000");
  state.balance = round2(state.balance + usd);
  bump(state);
  return state.balance;
}

export function withdraw(state, amount) {
  const usd = round2(Number(amount));
  if (!(usd > 0)) throw new Error("Amount must be positive");
  if (usd > state.balance + 1e-9) throw new Error("That’s more than your balance");
  state.balance = round2(state.balance - usd);
  bump(state);
  return state.balance;
}

export function proposeResolution(state, { marketId, outcome, evidence, now = Date.now() }) {
  const m = market(state, marketId);
  if (m.status !== "open") throw new Error("Market is not open");
  if (m.ends > now) throw new Error("Market has not reached its deadline");
  if (outcome !== "yes" && outcome !== "no") throw new Error("Outcome must be yes or no");
  m.status = "proposed";
  m.outcome = outcome;
  m.proposedAt = now;
  m.evidence = String(evidence || "").slice(0, 280);
  pushEvent(state, `<b>Quorum</b> proposed ${outcome === "yes" ? "Yes" : "No"} on “${esc(short(m.t))}”`, now);
  bump(state);
  return m;
}

export function overrideResolution(state, { marketId, outcome, now = Date.now() }) {
  const m = market(state, marketId);
  if (m.status !== "proposed") throw new Error("Nothing to override yet");
  if (now > m.proposedAt + CHALLENGE_MS) throw new Error("The 24 hour override window has closed");
  if (outcome !== "yes" && outcome !== "no") throw new Error("Outcome must be yes or no");
  if (m.overrideBy) throw new Error("An override is already recorded");
  m.overrideBy = "human";
  m.outcome = outcome;
  m.evidence = "Human override inside the 24 hour window.";
  pushEvent(state, `<b>You</b> overrode the resolution on “${esc(short(m.t))}” to ${outcome === "yes" ? "Yes" : "No"}`, now);
  bump(state);
  return m;
}

function nearPayMicro(m, pos, win) {
  const yes = m.realYes || 0;
  const no = m.realNo || 0;
  const both = yes > 0 && no > 0;
  const micro = Number(usdToMicro(pos.cost));
  const winPool = win === "yes" ? yes : no;
  if (!both) return { payMicro: micro, release: micro, extra: 0, slash: 0 };
  if (pos.side !== win) return { payMicro: 0, release: 0, extra: 0, slash: micro };
  const extra = winPool ? Math.floor((Math.abs(win === "yes" ? no : yes) * micro) / winPool) : 0;
  return { payMicro: micro + extra, release: micro, extra, slash: 0 };
}

function payLedger(ledger, m, win, now) {
  const positions = ledger.positions || [];
  const resolved = ledger.resolved || [];
  const kept = [];
  for (const pos of positions) {
    if (pos.mid !== m.id) {
      kept.push(pos);
      continue;
    }
    let pay;
    if (pos.near) {
      const settled = nearPayMicro(m, pos, win);
      pay = microToUsd(settled.payMicro);
      if (ledger.accountId && (settled.release || settled.extra || settled.slash)) {
        m.nearOps = m.nearOps || [];
        m.nearOps.push({
          accountId: ledger.accountId,
          release: settled.release,
          extra: settled.extra,
          slash: settled.slash,
        });
      }
    } else {
      pay = pos.side === win ? round2(pos.shares) : 0;
    }
    ledger.balance = round2(ledger.balance + pay);
    resolved.unshift({
      t: plain(m.t),
      side: pos.side,
      cost: pos.cost,
      pay,
      won: pos.side === win,
      date: new Date(now).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    });
  }
  ledger.positions = kept;
  ledger.resolved = resolved;
}

export function finalize(state, { marketId, now = Date.now() }) {
  const m = market(state, marketId);
  if (m.status !== "proposed") throw new Error("Quorum has not proposed a resolution");
  if (now < m.proposedAt + CHALLENGE_MS) throw new Error("The 24 hour window is still open");
  const pool = dePool(m.pool);
  const win = m.outcome;
  const ledgers = state.ledgers?.length ? state.ledgers : [state];
  for (const ledger of ledgers) payLedger(ledger, m, win, now);
  const allocated = BigInt(microString(m.feeAgent)) + BigInt(microString(m.feePencils));
  const leftover = pool.fees > allocated ? pool.fees - allocated : 0n;
  const feeUsd = microToUsd(leftover);
  const stakers = Object.entries(m.coalitionShares || {}).filter(([, v]) => v.usd > 0);
  const stakeSum = stakers.reduce((s, [, v]) => s + v.usd, 0);
  if (win === "yes" && stakeSum > 0 && feeUsd > 0) {
    for (const [id, v] of stakers) {
      const share = round2((feeUsd * v.usd) / stakeSum);
      if (SYSTEM[id]) {
        state.banks[id] = round2((state.banks[id] || 0) + share);
        continue;
      }
      const owner = ledgers.find((l) => (l.agents || []).some((a) => a.id === id));
      const target = owner || (id === "me" || id === "you" ? ledgers[0] : null);
      if (target && !target.accountId) target.balance = round2(target.balance + share);
    }
  }
  m.status = "resolved";
  m.resolvedAt = now;
  m.nearSettled = !m.nearOps || !m.nearOps.length;
  pushEvent(state, `<b>Quorum</b> finalized ${win === "yes" ? "Yes" : "No"} on “${esc(short(m.t))}”`, now);
  bump(state);
  return m;
}

const RESET_MS = 6 * 60 * 60 * 1000;

export function resetAccount() {
  throw new Error("There is no demo balance. Refund unused NEAR to your wallet.");
}

export function withLedger(state, ledger, fn) {
  if (!ledger || ledger === state) return fn();
  const prev = {
    balance: state.balance,
    positions: state.positions,
    agents: state.agents,
    resolved: state.resolved,
    notif: state.notif,
    accountId: state.accountId,
  };
  state.balance = ledger.balance;
  state.positions = ledger.positions;
  state.agents = ledger.agents;
  state.resolved = ledger.resolved;
  state.notif = ledger.notif;
  state.accountId = ledger.accountId || "";
  try {
    const result = fn();
    ledger.balance = state.balance;
    ledger.positions = state.positions;
    ledger.agents = state.agents;
    ledger.resolved = state.resolved;
    ledger.notif = state.notif;
    ledger.accountId = state.accountId;
    return result;
  } finally {
    state.balance = prev.balance;
    state.positions = prev.positions;
    state.agents = prev.agents;
    state.resolved = prev.resolved;
    state.notif = prev.notif;
    state.accountId = prev.accountId;
  }
}

export function resetState(now = Date.now()) {
  return createState(now);
}

export function clientView(state, now = Date.now()) {
  return {
    rev: state.rev,
    accountId: state.accountId || "",
    balance: state.balance,
    positions: state.positions,
    agents: state.agents.map((a) => ({
      id: a.id,
      name: a.name,
      handle: a.handle,
      kind: a.kind,
      glyph: a.glyph,
      perms: a.perms,
      watch: a.watch || "",
      limit: a.limit,
      spent: a.spent,
      created: a.created,
      live: !!a.live,
      publicKey: a.publicKey || "",
      policy: a.policy,
    })),
    notif: state.notif,
    markets: state.markets.map((m) => ({
      id: m.id,
      t: m.t,
      p: m.p,
      vol: m.vol,
      ends: m.ends,
      src: m.src,
      by: m.by,
      co: m.co,
      counter: m.counter,
      counterOf: m.counterOf,
      ct: m.ct,
      traders: m.traders,
      sum: m.sum,
      crit: m.crit,
      hist: m.hist,
      trades: m.trades.map((tr) => ({ ...tr, ago: Math.max(0, Math.round((now - tr.t) / 60000)) })),
      created: m.created || 0,
      status: m.status,
      outcome: m.outcome,
      proposedAt: m.proposedAt,
      evidence: m.evidence,
      feedUrl: m.feedUrl || "",
      awaitingSource: !!m.awaitingSource,
      narrative: m.narrative || "",
      role: m.role || "",
      feeAgent: microToUsd(BigInt(microString(m.feeAgent))),
      feePencils: microToUsd(BigInt(microString(m.feePencils))),
    })),
    feeds: (state.feeds || []).slice(0, 8),
    events: state.events,
    activity: (state.activity || []).slice(0, 40),
    resolved: state.resolved || [],
    near: {
      network: process.env.NEAR_NETWORK || "testnet",
      contract: process.env.PENCILS_CONTRACT || "pencilsbuzz.testnet",
      parent: state.accountId || "",
      agents: Object.values(SYSTEM).map((a) => a.handle),
      intents: "dry",
      ai: process.env.NEAR_AI_API_KEY ? "near-ai" : "scripted",
      mode: "testnet-near",
    },
    banks: state.banks,
    fees: (() => {
      const fees = feeBook(state);
      const byAgent = {};
      for (const [id, micro] of Object.entries(fees.byAgent)) byAgent[id] = microToUsd(BigInt(microString(micro)));
      return { pencils: microToUsd(BigInt(fees.pencils)), byAgent };
    })(),
  };
}

export function setSummary(state, id, sum) {
  const m = market(state, id);
  m.sum = sum.includes("{p}") ? sum : `${sum} ({p}%)`;
  bump(state);
}

export { CHALLENGE_MS, DAY, SYSTEM, esc, plain, short };
