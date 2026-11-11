import { createState } from "../engine/book.mjs";
import { step } from "../server/swarm.mjs";

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
console.log(`Opened ${state.markets.length} markets. Pulse bank $${state.banks.pulse}.`);

for (let i = 1; i <= 24; i++) {
  now += 60_000;
  const actions = step(state, rand, now);
  if (!actions.length) continue;
  console.log(`t+${i}m  ${actions.join(" | ")}`);
}

const sample = state.markets.find((m) => m.id === "launch-week");
sample.ends = now - 1000;
const proposed = step(state, rand, now);
console.log(`deadline  ${proposed.join(" | ")}`);
now += 25 * 60 * 60 * 1000;
const fin = step(state, rand, now);
console.log(`+24h      ${fin.join(" | ")}`);
console.log(`Cash left on the demo account: $${state.balance.toFixed(2)}`);
console.log(`Open markets: ${state.markets.filter((m) => m.status === "open").length}`);
console.log(`Resolved: ${state.markets.filter((m) => m.status === "resolved").map((m) => `${m.id}=${m.outcome}`).join(", ") || "none"}`);
