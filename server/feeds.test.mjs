import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createState, scoreThesis } from "../engine/book.mjs";
import { hardenThesis, parseDraft, publishDraft } from "./agents.mjs";
import { postsFromRss, postsFromX } from "./feeds.mjs";
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
  assert.equal(book.seenFeeds.at(-1), "x:1");
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
