import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createState, scoreThesis } from "../engine/book.mjs";
import { hardenThesis, parseDraft, parseVerdict, publicSourceUrl, publishDraft } from "./agents.mjs";
import { postsFromRss, postsFromX } from "./feeds.mjs";
import { applyDeskPlan, step } from "./swarm.mjs";
import { closeStore, openStore, reserveAgentCall, reserveAiCall } from "./store.mjs";

test("rss and X readers keep a title and a source", () => {
  const rss = `<?xml version="1.0"?><rss><channel><item><title>Chip prices fall 12% before June</title><link>https://example.com/chips</link></item></channel></rss>`;
  const news = postsFromRss(rss, "news");
  assert.equal(news.length, 1);
  assert.equal(news[0].source, "news");
  assert.match(news[0].title, /12%/);
  const x = postsFromX(
    "NEARProtocol",
    "## posts\n\n* NEAR Intents is now live in Talos and the desk routed $1 trillion before the report.\n* hi",
  );
  assert.equal(x.length, 1);
  assert.equal(x[0].source, "x");
  assert.equal(x[0].url, "https://x.com/NEARProtocol");
});

test("an agent draft becomes a market and a human cannot publish", () => {
  const draft = parseDraft('Sure. {"title":"Bitcoin trades above $150000 before December 2026 on the price index","days":7}');
  assert.equal(draft.days, 7);
  const title = hardenThesis("A vague claim about chips");
  assert.equal(scoreThesis(title).ok, true);
  const book = createState(1_700_000_000_000);
  const user = { id: "ada", balance: 250, agents: [], positions: [], resolved: [], notif: {} };
  user.agents.push({
    id: "scout",
    name: "Scout",
    perms: { propose: true, trade: false },
    watch: "bitcoin",
    limit: 50,
    spent: 0,
  });
  const post = { id: "x:1", source: "x", title: "Bitcoin jumps on the price index", url: "https://x.com/NEARProtocol" };
  const created = publishDraft(book, [user], { title: "Bitcoin stays above $150000 before December 2026", days: 7 }, post, 1_700_000_000_000);
  assert.equal(created.by, "scout");
  assert.equal(created.src[0], "x");
  assert.equal(created.feedUrl, post.url);
  assert.match(created.crit, /x\.com\/NEARProtocol/);
  assert.match(created.crit, /trade price is not the result/);
  assert.equal(book.seenFeeds.at(-1), "x:1");
  assert.throws(
    () => publishDraft(book, [user], { title: "Bitcoin stays above $150000 before December 2026", days: 7 }, { id: "x:2", source: "x", title: "No link", url: "" }, 1_700_000_000_001),
    /no source/,
  );
});

test("quorum waits on a source and the timer does not trade", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const linked = state.markets.find((m) => m.id === "btc-150");
  linked.feedUrl = "https://www.coingecko.com/en/coins/bitcoin";
  linked.ends = now - 1;
  const open = state.markets.find((m) => m.id === "launch-week");
  open.ends = now - 1;
  const actions = step(state, () => 0.99, now);
  assert.equal(linked.status, "open");
  assert.equal(linked.awaitingSource, true);
  assert.equal(open.status, "open");
  assert.equal(open.outcome, null);
  assert.equal(open.awaitingSource, true);
  assert.ok(actions.some((line) => line.includes("quorum waiting on btc-150")));
  assert.ok(actions.some((line) => line.includes("quorum waiting on launch-week")));
  const banks = { ...state.banks };
  const prices = state.markets.map((m) => m.p);
  step(state, () => 0, now + 5000);
  assert.deepEqual(state.banks, banks);
  assert.deepEqual(state.markets.map((m) => m.p), prices);
});

test("a desk plan funds both sides and does not mint NEAR", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const market = state.markets.find((m) => m.id === "btc-150");
  const yes = BigInt(market.pool.yes);
  const no = BigInt(market.pool.no);
  const collateral = BigInt(market.pool.collateral);
  const yesLiab = BigInt(market.pool.yesLiab);
  const bank = state.banks.ledger;
  const actions = applyDeskPlan(state, { marketId: "btc-150", quote: null, deepen: 40, counter: false }, now);
  assert.ok(actions.some((line) => line.includes("ledger added $40")));
  assert.equal(state.banks.ledger, bank - 40);
  assert.equal(BigInt(market.pool.yes), yes + 40_000_000n);
  assert.equal(BigInt(market.pool.no), no + 40_000_000n);
  assert.equal(BigInt(market.pool.collateral), collateral + 40_000_000n);
  assert.equal(BigInt(market.pool.yesLiab), yesLiab);
  assert.equal(BigInt(market.pool.yes) + BigInt(market.pool.yesLiab), BigInt(market.pool.collateral));
  assert.equal(BigInt(market.pool.no) + BigInt(market.pool.noLiab), BigInt(market.pool.collateral));
  assert.equal(market.realYes || 0, 0);
  assert.equal(market.realNo || 0, 0);
  assert.equal(state.positions.length, 0);
});

test("a desk quote leans the book and a counter opens only from the plan", () => {
  const now = 1_700_000_000_000;
  const state = createState(now);
  const market = state.markets.find((m) => m.id === "btc-150");
  const before = market.p;
  const actions = applyDeskPlan(state, { marketId: "btc-150", quote: 0.62, deepen: 0, counter: true }, now);
  assert.ok(market.p > before);
  assert.ok(actions.some((line) => line.startsWith("ledger quoted")));
  assert.ok(actions.some((line) => line.includes("contra opened a counter")));
  assert.equal(market.realYes || 0, 0);
  assert.equal(state.positions.length, 0);
  assert.equal(state.banks.ledger < 2000, true);
  const quiet = createState(now);
  const held = applyDeskPlan(quiet, { marketId: "btc-150", quote: 0.5, deepen: 0, counter: false }, now);
  assert.deepEqual(held, []);
  assert.equal(quiet.banks.ledger, 2000);
});

test("desk JSON keeps a quote and an old draft still parses", () => {
  const rich = parseDraft(
    '{"title":"Bitcoin trades above $150000 before December 2026 on the price index","days":7,"quote":0.62,"deepen":40,"counter":true}',
  );
  assert.equal(rich.quote, 0.62);
  assert.equal(rich.deepen, 40);
  assert.equal(rich.counter, true);
  const old = parseDraft('{"title":"Bitcoin trades above $150000 before December 2026 on the price index","days":7}');
  assert.equal(old.days, 7);
  assert.equal(old.quote, null);
  assert.equal(old.deepen, 0);
  assert.equal(old.counter, false);
  const pct = parseDraft('{"title":"Bitcoin trades above $150000 before December 2026 on the price index","quote":62,"deepen":15,"counter":"yes"}');
  assert.equal(pct.quote, 0.62);
  assert.equal(pct.deepen, 0);
  assert.equal(pct.counter, false);
  assert.equal(parseVerdict('{"outcome":"no"}'), "no");
  assert.equal(parseVerdict("maybe"), "unsure");
  assert.equal(publicSourceUrl("http://127.0.0.1/secret"), "");
  assert.equal(publicSourceUrl("https://www.coingecko.com/en/coins/bitcoin"), "https://www.coingecko.com/en/coins/bitcoin");
});

test("agent drafts do not spend the encyclopedia budget", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pencils-agent-"));
  openStore(path.join(dir, "pencils.sqlite"));
  const start = Date.parse("2026-11-12T00:00:00Z");
  assert.equal(reserveAgentCall(start).ok, true);
  assert.equal(reserveAgentCall(start + 1000).reason, "gap");
  assert.equal(reserveAiCall("btc", start).ok, true);
  closeStore();
});
