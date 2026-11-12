import { createState, proposeResolution } from "../engine/book.mjs";
import { applyDeskPlan, step } from "../server/swarm.mjs";

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(5);
let now = Date.UTC(2026, 10, 11);
const state = createState(now);
console.log(`Opened ${state.markets.length} sentences. Ledger bank $${state.banks.ledger}.`);

let noise = 0;
for (let i = 1; i <= 24; i++) {
  now += 60_000;
  noise += step(state, rand, now).length;
}
console.log(`Timer rounds with no desk plan: ${noise} actions.`);

const sample = state.markets.find((m) => m.id === "btc-150");
sample.feedUrl = "https://www.coingecko.com/en/coins/bitcoin";
const desk = applyDeskPlan(state, { marketId: sample.id, quote: 0.42, deepen: 40, counter: false }, now);
console.log(`desk      ${desk.join(" | ") || "held"}`);
console.log(`Ledger bank $${state.banks.ledger}. Quote ${sample.p.toFixed(3)}. NEAR yes ${sample.realYes || 0}.`);

sample.ends = now - 1000;
const waiting = step(state, rand, now);
console.log(`deadline  ${waiting.join(" | ")}`);
proposeResolution(state, {
  marketId: sample.id,
  outcome: "no",
  evidence: "Reviewer checked https://www.coingecko.com/en/coins/bitcoin. The trade price is not the result.",
  now,
});
now += 25 * 60 * 60 * 1000;
const fin = step(state, rand, now);
console.log(`+24h      ${fin.join(" | ")}`);
console.log(`Open sentences: ${state.markets.filter((m) => m.status === "open").length}`);
console.log(`Resolved: ${state.markets.filter((m) => m.status === "resolved").map((m) => `${m.id}=${m.outcome}`).join(", ") || "none"}`);
