import assert from "node:assert/strict";
import test from "node:test";
import { bet, connectAgent, createState, finalize, openCounter, overrideResolution, propose, proposeResolution, setPerm, stake, swarmTrade, withLedger } from "./book.mjs";
import { applyBuy, freshPool, LIQ, seedTo, spot } from "./math.mjs";

test("opening book is solvent and near the designed price", () => {
  const state = createState(1_700_000_000_000);
  for (const m of state.markets) {
    const pool = {
      yes: BigInt(m.pool.yes),
      no: BigInt(m.pool.no),
      collateral: BigInt(m.pool.collateral),
      yesLiab: BigInt(m.pool.yesLiab),
      noLiab: BigInt(m.pool.noLiab),
    };
    assert.equal(pool.yes + pool.yesLiab, pool.collateral);
    assert.equal(pool.no + pool.noLiab, pool.collateral);
    assert.ok(Math.abs(m.p - m.hist.at(-1)) < 1e-9);
  }
  const gpu = state.markets.find((m) => m.id === "gpu-drop");
  assert.ok(Math.abs(gpu.p - 0.38) < 0.01, `gpu price ${gpu.p}`);
  const btc = state.markets.find((m) => m.id === "btc-150");
  assert.ok(Math.abs(btc.p - 0.17) < 0.01, `btc price ${btc.p}`);
});

test("buying Yes raises the price and keeps the pool solvent", () => {
  const state = createState(1_700_000_000_000);
  const before = state.markets.find((m) => m.id === "launch-week").p;
  const fill = bet(state, { marketId: "launch-week", side: "yes", amount: 25, now: 1_700_000_000_000 });
  const m = state.markets.find((x) => x.id === "launch-week");
  assert.ok(m.p > before);
  assert.ok(fill.shares > 25);
  assert.equal(state.balance, 225);
  assert.equal(state.positions.length, 1);
  assert.equal(state.positions[0].side, "yes");
  const pool = m.pool;
  assert.equal(BigInt(pool.yes) + BigInt(pool.yesLiab), BigInt(pool.collateral));
  assert.equal(BigInt(pool.no) + BigInt(pool.noLiab), BigInt(pool.collateral));
});

test("agent spending limit blocks a trade and a coalition stake still clears", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const agent = connectAgent(state, { name: "Night Owl", kind: "near", now });
  assert.equal(agent.handle, "agent-1.pencilsbuzz.testnet");
  assert.equal(agent.policy.methodNames.includes("lock"), true);
  setPerm(state, { id: agent.id, perm: "trade", on: true });
  agent.limit = 10;
  bet(state, { marketId: "agents-word", side: "no", amount: 10, via: agent.id, now });
  assert.throws(() => bet(state, { marketId: "agents-word", side: "no", amount: 5, via: agent.id, now }), /limit/);
  const bal = state.balance;
  stake(state, { marketId: "agents-word", agentId: agent.id, amount: 10, now });
  assert.equal(state.balance, Math.round((bal - 10) * 100) / 100);
  const m = state.markets.find((x) => x.id === "agents-word");
  assert.ok(m.co.some(([id]) => id === agent.id));
});

test("counter-market links both sides and a new thesis starts at 50%", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const opened = openCounter(state, { marketId: "btc-150", agentId: "contra", now });
  assert.equal(opened.created, true);
  const orig = state.markets.find((m) => m.id === "btc-150");
  const counter = state.markets.find((m) => m.id === opened.goto);
  assert.equal(orig.counter, counter.id);
  assert.equal(counter.counterOf, orig.id);
  assert.ok(counter.p > 0.7);
  const again = openCounter(state, { marketId: "btc-150", now });
  assert.equal(again.created, false);
  const thesis = propose(state, {
    title: "Solana DEX volume beats Ethereum DEX volume for 5 straight days before December 15.",
    days: 7,
    by: "pulse",
    now,
  });
  assert.ok(Math.abs(thesis.p - 0.5) < 0.01);
  assert.equal(thesis.by, "pulse");
  assert.throws(() => propose(state, { title: thesis.t, days: 7, by: "you", now }), /Only an agent/);
  assert.throws(() => propose(state, { title: "something vague", days: 7, by: "pulse", now }), /Quorum/);
});

test("resolution pays winning shares after the 24 hour window and an override sticks", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  bet(state, { marketId: "launch-week", side: "yes", amount: 20, now });
  const shares = state.positions[0].shares;
  const m = state.markets.find((x) => x.id === "launch-week");
  m.ends = now - 1;
  assert.throws(() => proposeResolution(state, { marketId: "launch-week", outcome: "yes", now: now - 2 }), /deadline/);
  proposeResolution(state, { marketId: "launch-week", outcome: "no", evidence: "waitlist hit the target", now });
  overrideResolution(state, { marketId: "launch-week", outcome: "yes", now: now + 1000 });
  assert.throws(() => finalize(state, { marketId: "launch-week", now: now + 1000 }), /window/);
  const bal = state.balance;
  finalize(state, { marketId: "launch-week", now: now + 25 * 60 * 60 * 1000 });
  assert.ok(Math.abs(state.balance - (bal + shares)) < 0.02);
  assert.equal(state.positions.length, 0);
  assert.equal(state.resolved[0].won, true);
});

test("resolution pays each account its own shares", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const a = { balance: 100, positions: [], agents: [], resolved: [], notif: {} };
  const b = { balance: 100, positions: [], agents: [], resolved: [], notif: {} };
  state.ledgers = [a, b];
  withLedger(state, a, () => bet(state, { marketId: "launch-week", side: "yes", amount: 20, now }));
  withLedger(state, b, () => bet(state, { marketId: "launch-week", side: "no", amount: 10, now }));
  const m = state.markets.find((x) => x.id === "launch-week");
  m.ends = now - 1;
  proposeResolution(state, { marketId: "launch-week", outcome: "yes", now });
  finalize(state, { marketId: "launch-week", now: now + 25 * 60 * 60 * 1000 });
  assert.ok(a.balance > 100);
  assert.equal(a.positions.length, 0);
  assert.equal(b.positions.length, 0);
  assert.ok(b.balance < 100);
  assert.equal(a.resolved[0].won, true);
  assert.equal(b.resolved[0].won, false);
  assert.equal(state.balance, 250);
});

test("a solo near position returns the stake on either outcome", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const user = { balance: 5, positions: [], agents: [], resolved: [], notif: {}, accountId: "ada.testnet" };
  state.ledgers = [user];
  withLedger(state, user, () => bet(state, { marketId: "launch-week", side: "yes", amount: 2, now, near: true, prepaid: true }));
  assert.equal(user.balance, 5);
  const m = state.markets.find((x) => x.id === "launch-week");
  assert.equal(m.realYes, 2_000_000);
  m.ends = now - 1;
  proposeResolution(state, { marketId: "launch-week", outcome: "no", now });
  finalize(state, { marketId: "launch-week", now: now + 25 * 60 * 60 * 1000 });
  assert.equal(user.balance, 7);
  assert.equal(user.positions.length, 0);
  assert.equal(user.resolved[0].won, false);
  assert.equal(user.resolved[0].pay, 2);
  assert.equal(m.nearOps.length, 1);
  assert.equal(m.nearOps[0].accountId, "ada.testnet");
  assert.equal(m.nearOps[0].release, 2_000_000);
  assert.equal(m.nearOps[0].slash, 0);
  assert.equal(m.nearSettled, false);
});

test("near positions on both sides split the losing stake", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const yes = { balance: 5, positions: [], agents: [], resolved: [], notif: {}, accountId: "yes.testnet" };
  const no = { balance: 5, positions: [], agents: [], resolved: [], notif: {}, accountId: "no.testnet" };
  state.ledgers = [yes, no];
  withLedger(state, yes, () => bet(state, { marketId: "launch-week", side: "yes", amount: 2, now, near: true, prepaid: true }));
  withLedger(state, no, () => bet(state, { marketId: "launch-week", side: "no", amount: 2, now, near: true, prepaid: true }));
  const m = state.markets.find((x) => x.id === "launch-week");
  m.ends = now - 1;
  proposeResolution(state, { marketId: "launch-week", outcome: "yes", now });
  finalize(state, { marketId: "launch-week", now: now + 25 * 60 * 60 * 1000 });
  assert.equal(yes.balance, 9);
  assert.equal(no.balance, 5);
  assert.equal(yes.resolved[0].pay, 4);
  assert.equal(no.resolved[0].pay, 0);
  const yesOp = m.nearOps.find((op) => op.accountId === "yes.testnet");
  const noOp = m.nearOps.find((op) => op.accountId === "no.testnet");
  assert.equal(yesOp.release, 2_000_000);
  assert.equal(yesOp.extra, 2_000_000);
  assert.equal(noOp.slash, 2_000_000);
  assert.equal(m.nearSettled, false);
});

test("swarm agents trade from their own bankroll", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const before = state.balance;
  const bank = state.banks.pulse;
  swarmTrade(state, { marketId: "gpu-drop", side: "yes", amount: 8, agentId: "pulse", now });
  assert.equal(state.balance, before);
  assert.ok(state.banks.pulse < bank);
  assert.equal(state.events[0].html.includes("Pulse"), true);
});

test("fixture: $10 Yes buy from a fresh 50/50 pool", () => {
  const pool = freshPool();
  assert.equal(pool.yes, LIQ);
  const next = applyBuy(pool.yes, pool.no, 10_000_000n, "yes");
  seedTo(pool, 0.5);
  assert.ok(Math.abs(spot(pool.yes, pool.no) - 0.5) < 1e-9);
  console.log("FIXTURE", {
    shares: next.shares.toString(),
    fee: next.fee.toString(),
    net: next.net.toString(),
    yes: next.yes.toString(),
    no: next.no.toString(),
  });
});
