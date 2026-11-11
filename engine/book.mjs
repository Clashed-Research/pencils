import { applyBuy, commitPool, freshPool, microToUsd, SCALE, seedTo, spot, usdToMicro } from "./math.mjs";
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

function tradeInto(state, m, side, usd, who, now, { position = true, coalition = false, limit = true } = {}) {
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
  spend(state, who, usd, { limit });
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
  m.trades.unshift({ who: who === "me" ? "h:you.near" : who, side, amt: round2(usd), t: now });
  m.trades = m.trades.slice(0, 24);
  if (position && (who === "me" || state.agents.some((a) => a.id === who))) {
    state.positions.unshift({
      id: "p" + now.toString(36) + who.slice(0, 3),
      mid: m.id,
      side,
      shares,
      cost: round2(usd),
      via: who,
      t: now,
    });
  }
  if (coalition) {
    const prev = m.coalitionShares[who] || { usd: 0, shares: 0 };
    m.coalitionShares[who] = { usd: round2(prev.usd + usd), shares: prev.shares + shares };
    const row = m.co.find((c) => c[0] === who);
    if (row) row[1] = round2(row[1] + usd);
    else m.co.push([who, round2(usd)]);
  }
  return { shares, price: side === "yes" ? priceBefore : 1 - priceBefore, p: m.p, fee: microToUsd(next.fee) };
}

export function bet(state, { marketId, side, amount, via = "me", now = Date.now() }) {
  const m = market(state, marketId);
  const usd = round2(Number(amount));
  if (!(usd > 0)) throw new Error("Amount must be positive");
  const who = via === "me" ? "me" : via;
  if (who !== "me") {
    const a = state.agents.find((x) => x.id === who);
    if (!a) throw new Error("Connect that agent first");
    if (!a.perms.trade) throw new Error(`${a.name} is not allowed to trade`);
  }
  const fill = tradeInto(state, m, side, usd, who, now, { position: true });
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

export function connectAgent(state, { name, kind = "near", watch = "", now = Date.now() }) {
  const clean = String(name || "").trim().slice(0, 24) || ["Night Owl", "Macro Scout", "Signal Fox", "Drift"][state.agents.length % 4];
  const n = state.agents.length + 1;
  const a = {
    id: "ua" + now.toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    name: clean,
    handle: `agent-${n}.pencilsbuzz.testnet`,
    kind: kind === "api" ? "api" : "near",
    glyph: ["ring", "plus", "bars", "half"][(n - 1) % 4],
    watch: String(watch || "").trim().slice(0, 80),
    perms: { propose: true, trade: false },
    limit: 50,
    spent: 0,
    created: now,
    policy: {
      contract: process.env.PENCILS_CONTRACT || "pencils.testnet",
      methodNames: ["buy", "stake", "create_market"],
      allowanceNear: "5",
    },
  };
  state.agents.push(a);
  pushEvent(state, `<b>${esc(clean)}</b> joined the swarm as ${esc(a.handle)}`, now);
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

export function stake(state, { marketId, agentId, amount, now = Date.now() }) {
  const m = market(state, marketId);
  const a = state.agents.find((x) => x.id === agentId);
  const system = SYSTEM[agentId];
  if (!a && !system) throw new Error("Pick an agent to stake with");
  const usd = round2(Number(amount));
  if (!(usd > 0)) throw new Error("Stake must be positive");
  if (!system && ![10, 25, 50].includes(usd)) throw new Error("Stake 10, 25, or 50 dollars");
  tradeInto(state, m, "yes", usd, agentId, now, { position: false, coalition: true, limit: false });
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
    src: ["agent", `Counter-market opened by ${agentName(state, by)}`],
    by,
    co: [[by, 0]],
    counterOf: m.id,
    traders: 1,
    created: now,
    sum: "A fresh counter-market at {p}%. Early prices mirror the original thesis and will diverge as traders take sides.",
    crit: `Resolves Yes if the original thesis (“${plain(m.t)}”) resolves No under its own criteria.`,
    ct: null,
  });
  m.counter = id;
  state.markets.push(c);
  pushEvent(state, `<b>${esc(agentName(state, by))}</b> opened a counter-market on “${esc(short(m.t))}”`, now);
  bump(state);
  return { goto: id, created: true };
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

export function propose(state, { title, days = 7, by, now = Date.now(), source }) {
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
  const m = attachPool({
    id,
    t,
    p: 0.5,
    vol: 0,
    ends: now + len * DAY,
    src: source?.src || ["agent", `Proposed by ${agentName(state, by)}`],
    feedUrl: source?.url || "",
    by,
    co: [[by, 0]],
    traders: 1,
    created: now,
    sum: "Just listed at {p}%. Agents are gathering signals and the first trades will set the price.",
    crit: `Resolves Yes if the following is true by the deadline, verified by Quorum and two verifier agents: “${v}”`,
    ct: null,
  });
  m.hist = m.hist.map(() => m.p);
  state.markets.push(m);
  pushEvent(state, `<b>${esc(agentName(state, by))}</b> proposed “${esc(short(t))}”`, now);
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

function payLedger(ledger, m, win, now) {
  const positions = ledger.positions || [];
  const resolved = ledger.resolved || [];
  const kept = [];
  for (const pos of positions) {
    if (pos.mid !== m.id) {
      kept.push(pos);
      continue;
    }
    const pay = pos.side === win ? round2(pos.shares) : 0;
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
  const feeUsd = microToUsd(pool.fees);
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
      if (target) target.balance = round2(target.balance + share);
    }
  }
  m.status = "resolved";
  m.resolvedAt = now;
  pushEvent(state, `<b>Quorum</b> finalized ${win === "yes" ? "Yes" : "No"} on “${esc(short(m.t))}”`, now);
  bump(state);
  return m;
}

const RESET_MS = 6 * 60 * 60 * 1000;

export function resetAccount(user, now = Date.now()) {
  if (user.resetAt && now - user.resetAt < RESET_MS) {
    const mins = Math.ceil((RESET_MS - (now - user.resetAt)) / 60000);
    throw new Error(`You can reset the demo again in ${mins} minutes`);
  }
  user.balance = 250;
  user.positions = [];
  user.agents = [];
  user.resolved = [];
  user.notif = { ending: true, proposed: true, coalition: true, resolved: true };
  user.resetAt = now;
  return user;
}

export function withLedger(state, ledger, fn) {
  if (!ledger || ledger === state) return fn();
  const prev = {
    balance: state.balance,
    positions: state.positions,
    agents: state.agents,
    resolved: state.resolved,
    notif: state.notif,
  };
  state.balance = ledger.balance;
  state.positions = ledger.positions;
  state.agents = ledger.agents;
  state.resolved = ledger.resolved;
  state.notif = ledger.notif;
  try {
    const result = fn();
    ledger.balance = state.balance;
    ledger.positions = state.positions;
    ledger.agents = state.agents;
    ledger.resolved = state.resolved;
    ledger.notif = state.notif;
    return result;
  } finally {
    state.balance = prev.balance;
    state.positions = prev.positions;
    state.agents = prev.agents;
    state.resolved = prev.resolved;
    state.notif = prev.notif;
  }
}

export function resetState(now = Date.now()) {
  return createState(now);
}

export function clientView(state, now = Date.now()) {
  return {
    rev: state.rev,
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
    })),
    feeds: (state.feeds || []).slice(0, 8),
    events: state.events,
    resolved: [...(state.resolved || []), ...(state.archive || [])],
    near: {
      network: process.env.NEAR_NETWORK || "testnet",
      contract: process.env.PENCILS_CONTRACT || "pencils.testnet",
      parent: "you.near",
      agents: Object.values(SYSTEM).map((a) => a.handle),
      intents: "1click dry quotes",
      ai: process.env.NEAR_AI_API_KEY ? "near-ai" : "scripted",
      mode: process.env.NEAR_PRIVATE_KEY ? "chain" : "simulation",
    },
    banks: state.banks,
  };
}

export function setSummary(state, id, sum) {
  const m = market(state, id);
  m.sum = sum.includes("{p}") ? sum : `${sum} ({p}%)`;
  bump(state);
}

export { CHALLENGE_MS, DAY, SYSTEM, esc, plain, short };
