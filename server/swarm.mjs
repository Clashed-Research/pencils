import { CHALLENGE_MS, finalize, hasSource, openCounter, provideLiquidity, quoteToward, stake } from "../engine/book.mjs";

// `stake` stays imported so a desk plan can still record a coalition later.
void stake;

function clampQuote(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x >= 15 && x <= 85) return Math.round(x) / 100;
  if (x >= 0.15 && x <= 0.85) return Math.round(x * 100) / 100;
  return null;
}

// One desk plan, applied once when the model returns it. The timer does not invent trades.
export function applyDeskPlan(state, plan, now = Date.now()) {
  const actions = [];
  const m = state.markets.find((x) => x.id === plan?.marketId);
  if (!m || m.status !== "open" || m.ends <= now || !hasSource(m)) {
    actions.push("desk skipped: no open sourced market");
    return actions;
  }
  const quote = clampQuote(plan.quote);
  if (quote != null && Math.abs(quote - 0.5) >= 0.04 && Math.abs(m.p - quote) >= 0.03) {
    const cap = Math.min(240, Math.floor(state.banks.ledger));
    if (cap >= 8) {
      try {
        const moved = quoteToward(state, { marketId: m.id, target: quote, maxUsd: cap, now });
        if (moved.spent >= 1) actions.push(`ledger quoted ${m.id} toward ${quote.toFixed(2)} for $${moved.spent}`);
      } catch (err) {
        actions.push(`ledger quote skipped: ${err.message}`);
      }
    }
  }
  const deepen = [20, 40, 80].includes(Number(plan.deepen)) ? Number(plan.deepen) : 0;
  if (deepen > 0 && state.banks.ledger + 1e-9 >= deepen) {
    try {
      provideLiquidity(state, { marketId: m.id, amount: deepen, now });
      actions.push(`ledger added $${deepen} on both sides of ${m.id}`);
    } catch (err) {
      actions.push(`ledger liquidity skipped: ${err.message}`);
    }
  }
  const sided = m.p >= 0.62 || m.p <= 0.38;
  if (plan.counter === true && sided && !m.counter && !m.counterOf && state.banks.contra >= 5) {
    try {
      const opened = openCounter(state, { marketId: m.id, agentId: "contra", now });
      if (opened.created) actions.push(`contra opened a counter to ${m.id}`);
    } catch (err) {
      actions.push(`contra counter skipped: ${err.message}`);
    }
  }
  return actions;
}

// The clock only waits on sources and finalizes a challenge window. It does not trade.
export function step(state, _rand, now = Date.now()) {
  const actions = [];
  for (const m of state.markets) {
    if (m.status === "open" && m.ends <= now) {
      if (!m.awaitingSource) {
        m.awaitingSource = true;
        const label = escapeHtml(String(m.src?.[1] || m.feedUrl || "the named source").slice(0, 80));
        state.events.unshift({
          html: `<b>Quorum</b> is waiting on the source for “${escapeHtml(plainTitle(m))}”: ${label}`,
          t: now,
        });
        state.events = state.events.slice(0, 30);
        state.rev += 1;
        actions.push(`quorum waiting on ${m.id}`);
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
  return actions;
}

function plainTitle(m) {
  return String(m.t || "").replace(/\[\[|\]\]/g, "").slice(0, 56);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

