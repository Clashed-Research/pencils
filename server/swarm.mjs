import { bet, CHALLENGE_MS, finalize, openCounter, propose, proposeResolution, stake, swarmTrade, withLedger } from "../engine/book.mjs";

const AGENTS = ["pulse", "ledger", "contra"];

function openMarkets(state, now) {
  return state.markets.filter((m) => m.status === "open" && m.ends > now);
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length)];
}

function dollars(rand, min, max) {
  return Math.round(min + rand() * (max - min));
}

// One coordination round. `rand` is a function returning [0, 1). Safe to call forever.
export function step(state, rand, now = Date.now()) {
  const actions = [];

  for (const m of state.markets) {
    if (m.status === "open" && m.ends <= now) {
      const outcome = scriptedOutcome(m.id);
      try {
        proposeResolution(state, { marketId: m.id, outcome, evidence: "Simulation oracle. Independent of the trade price.", now });
        actions.push(`quorum proposed ${outcome} on ${m.id}`);
      } catch (err) {
        actions.push(`quorum skip ${m.id}: ${err.message}`);
      }
    } else if (m.status === "proposed" && now >= m.proposedAt + CHALLENGE_MS) {
      try {
        finalize(state, { marketId: m.id, now });
        actions.push(`quorum finalized ${m.outcome} on ${m.id}`);
      } catch (err) {
        actions.push(`finalize skip ${m.id}: ${err.message}`);
      }
    }
  }

  const live = openMarkets(state, now);
  if (!live.length) return actions;

  const agent = AGENTS[Math.floor(rand() * AGENTS.length)];
  const m = pick(rand, live);
  let side = m.p >= 0.5 ? "yes" : "no";
  if (agent === "pulse") side = m.p >= 0.52 ? "yes" : m.p <= 0.48 ? "no" : side;
  if (agent === "ledger") side = m.p < 0.4 ? "yes" : m.p > 0.7 ? "no" : m.p >= 0.5 ? "yes" : "no";
  if (agent === "contra") side = m.p >= 0.5 ? "no" : "yes";
  const amount = Math.min(dollars(rand, 4, 9), Math.floor(state.banks[agent]));
  if (amount >= 4) {
    try {
      swarmTrade(state, { marketId: m.id, side, amount, agentId: agent, now });
      actions.push(`${agent} bought ${side} $${amount} on ${m.id}`);
    } catch (err) {
      actions.push(`${agent} trade skipped: ${err.message}`);
    }
  }

  if (rand() < 0.18) {
    const target = live.find((x) => x.p > 0.35 && x.p < 0.72 && !x.co.some(([id]) => id === "ledger"));
    const choice = target || pick(rand, live);
    if (state.banks.ledger >= 10) {
      try {
        stake(state, { marketId: choice.id, agentId: "ledger", amount: 10, now });
        actions.push(`ledger staked $10 on ${choice.id}`);
      } catch (err) {
        actions.push(`ledger stake skipped: ${err.message}`);
      }
    }
  }

  if (rand() < 0.12) {
    const oneSided = live.find((x) => !x.counter && !x.counterOf && (x.p >= 0.7 || x.p <= 0.3));
    if (oneSided && state.banks.contra >= 5) {
      try {
        const opened = openCounter(state, { marketId: oneSided.id, agentId: "contra", now });
        if (opened.created) actions.push(`contra opened a counter to ${oneSided.id}`);
      } catch (err) {
        actions.push(`contra counter skipped: ${err.message}`);
      }
    }
  }

  if (rand() < 0.08 && state.drafts.length) {
    const draft = state.drafts.shift();
    try {
      const created = propose(state, { title: draft.t, days: draft.days, by: "pulse", now });
      created.sum = draft.sum;
      created.crit = draft.crit;
      created.src = draft.src;
      actions.push(`pulse proposed ${created.id}`);
    } catch (err) {
      state.drafts.push(draft);
      actions.push(`pulse draft skipped: ${err.message}`);
    }
  }

  const ledgers = state.ledgers?.length ? state.ledgers : [null];
  for (const ledger of ledgers) {
    const tradeOwn = () => {
      for (const a of state.agents || []) {
        if (!a.perms.trade) continue;
        if (rand() > 0.45) continue;
        const left = Math.min(a.limit - a.spent, state.balance);
        const amt = Math.min(dollars(rand, 2, 6), Math.floor(left));
        if (amt < 2) continue;
        const words = String(a.watch || "")
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 2);
        const themed = words.length
          ? live.filter((m) => words.some((w) => m.t.toLowerCase().includes(w)))
          : [];
        const pickM = themed.length ? pick(rand, themed) : pick(rand, live);
        const userSide = pickM.p >= 0.5 ? "yes" : "no";
        try {
          bet(state, { marketId: pickM.id, side: userSide, amount: amt, via: a.id, now });
          actions.push(`${a.name} bought ${userSide} $${amt}`);
        } catch (err) {
          actions.push(`${a.name} skipped: ${err.message}`);
        }
      }
    };
    if (ledger) withLedger(state, ledger, tradeOwn);
    else tradeOwn();
  }

  if (rand() < 0.25) {
    const watch = pick(rand, live);
    state.events.unshift({
      html: `<b>Quorum</b> checked resolution sources for “${escapeHtml(watch.t.replace(/\[\[|\]\]/g, "").slice(0, 56))}”`,
      t: now,
    });
    state.events = state.events.slice(0, 30);
    state.rev += 1;
    actions.push(`quorum checked ${watch.id}`);
  }

  return actions;
}

function scriptedOutcome(id) {
  let h = 2166136261;
  for (const c of id) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 2 === 0 ? "yes" : "no";
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export { scriptedOutcome };
