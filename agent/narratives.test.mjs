import assert from "node:assert/strict";
import test from "node:test";
import { claimSimilarity } from "../engine/claims.mjs";
import {
  chooseListings,
  grokText,
  hottestTrend,
  HOUR_MS,
  parseNarrative,
  parsePublic,
  postsFromXApi,
  shouldRun,
  slotsLeft,
  trendQuery,
  waitMs,
} from "./narratives.mjs";

const trends = {
  data: [
    { trend_name: "Jensen", tweet_count: 1200 },
    { trend_name: "Nvidia", tweet_count: 90000 },
    { trend_name: "#AEWDynamite" },
  ],
};
const search = {
  data: [
    {
      id: "111",
      author_id: "9",
      text: "Nvidia named the loudest chip story in the live post count.",
      public_metrics: { like_count: 40 },
    },
    { id: "222", author_id: "missing", text: "This post has no author and must be dropped from the book." },
    {
      id: "333",
      author_id: "8",
      text: "Jensen spoke at a counted event with a public number.",
      public_metrics: { like_count: 3 },
    },
  ],
  includes: {
    users: [
      { id: "9", username: "chipdesk" },
      { id: "8", username: "quote_desk" },
    ],
  },
};

const posts = postsFromXApi(trends, search).posts;
const sample = JSON.stringify({
  narrative: "Nvidia posts are the loudest chip story in this hour of X search.",
  market: {
    title: "Nvidia stays inside the top 5 X trends before December 2026 on the chart",
    writeup: "Chip talk is the loudest cluster in the posts fetched this hour.",
    days: 7,
    post: 0,
    sourceUrl: "https://evil.example/phish",
  },
  thesis: {
    title: "Jensen is named in at least 100000 posts on the cited X post before December 2026",
    writeup: "The check is the name count on the Jensen post, not the chip rank.",
    days: 30,
    post: 1,
  },
});

const reuters = "https://www.reuters.com/world/chips-2026-11-12/";
const transcript = "https://www.sec.gov/Archives/edgar/data/1045810/transcript.htm";
const publicSample = JSON.stringify({
  narrative: "Chip supply is the loudest public story in this morning's reports.",
  market: {
    title: "Nvidia stays inside the top 5 public chip reports before December 2026 on the chart",
    writeup: "The check is the rank in the cited chip report, not a social post.",
    days: 7,
    sourceUrl: reuters,
  },
  thesis: {
    title: "Jensen is named in at least 100000 lines of the cited transcript before December 2026",
    writeup: "The check is the name count in the transcript, not the chip rank.",
    days: 30,
    sourceUrl: "https://evil.example/not-cited",
  },
});

test("the hourly gate waits, and the X API payload becomes status posts", () => {
  assert.equal(shouldRun({ at: 0 }, 5_000, HOUR_MS), true);
  assert.equal(shouldRun({ at: 10_000 }, 10_000 + HOUR_MS - 1, HOUR_MS), false);
  assert.equal(shouldRun({ at: 10_000 }, 10_000 + HOUR_MS, HOUR_MS), true);
  assert.equal(waitMs({ at: 10_000 }, 10_000 + 1_000, HOUR_MS), HOUR_MS - 1_000);
  assert.equal(hottestTrend(trends).name, "Nvidia");
  assert.equal(hottestTrend({ data: [{ trend_name: "Alpha" }, { trend_name: "Beta" }] }).name, "Alpha");
  assert.equal(trendQuery("Nvidia"), "Nvidia -is:retweet");
  assert.equal(trendQuery("#AEWDynamite"), "#AEWDynamite -is:retweet");
  assert.equal(trendQuery("from:elon OR leak"), '"fromelon OR leak" -is:retweet');
  assert.equal(trendQuery("$"), "");
  const packed = postsFromXApi(trends, search);
  assert.equal(packed.trend.name, "Nvidia");
  assert.deepEqual(packed.posts.map((row) => row.url), [
    "https://x.com/chipdesk/status/111",
    "https://x.com/quote_desk/status/333",
  ]);
  assert.equal(packed.posts[0].label, "X @chipdesk");
  assert.match(packed.posts[0].text, /40 likes/);
  assert.equal(postsFromXApi(trends, { data: [] }).posts.length, 0);
});

test("a narrative reply is bound to fetched posts and the daily cap picks the thesis", () => {
  const parsed = parseNarrative(sample, posts);
  assert.equal(parsed.market.sourceUrl, "https://x.com/chipdesk/status/111");
  assert.equal(parsed.market.sourceLabel, "X @chipdesk");
  assert.equal(parsed.thesis.sourceUrl, "https://x.com/quote_desk/status/333");
  assert.equal(parsed.market.role, "narrative");
  assert.equal(parsed.thesis.role, "thesis");
  assert.ok(claimSimilarity(parsed.market.title, parsed.thesis.title) < 0.55);
  assert.equal(chooseListings(parsed, 2).map((row) => row.role).join(","), "narrative,thesis");
  assert.equal(chooseListings(parsed, 1)[0].role, "thesis");
  assert.equal(chooseListings(parsed, 0).length, 0);
  const onePost = parseNarrative(sample, [posts[0]]);
  assert.equal(onePost.thesis, null);
  assert.equal(slotsLeft([{ at: 1 }, { at: 2 }, { at: 3 }, { at: 4 }, { at: 5 }, { at: 6 }], 10), 0);
  assert.equal(slotsLeft([{ at: 1 }], 10), 5);
  assert.equal(parseNarrative('{"narrative":"too short","market":{"title":"x","days":7,"post":0}}', posts), null);
});

test("Grok text and citations bind a public market only to a real page", () => {
  const body = {
    output: [
      { type: "reasoning", content: [{ type: "output_text", text: "skip me" }] },
      {
        type: "message",
        role: "assistant",
        content: [
          {
            type: "output_text",
            text: publicSample,
            annotations: [
              { type: "url_citation", url: reuters, start_index: 0, end_index: 4, title: "1" },
              { type: "url_citation", url: "http://127.0.0.1/secret", start_index: 5, end_index: 8, title: "2" },
            ],
          },
        ],
      },
    ],
    citations: [reuters, transcript, "http://10.0.0.8/hidden"],
  };
  const grok = grokText(body);
  assert.equal(grok.text, publicSample);
  assert.deepEqual(grok.citations, [reuters, "http://127.0.0.1/secret", transcript, "http://10.0.0.8/hidden"]);
  const parsed = parsePublic(grok.text, grok.citations);
  assert.equal(parsed.market.sourceUrl, reuters);
  assert.equal(parsed.market.sourceLabel, "reuters.com");
  assert.equal(parsed.thesis, null);
  const both = parsePublic(
    publicSample.replace("https://evil.example/not-cited", transcript),
    grok.citations,
  );
  assert.equal(both.thesis.sourceUrl, transcript);
  assert.equal(both.thesis.sourceLabel, "sec.gov");
  assert.equal(chooseListings(both, 2).map((row) => row.role).join(","), "narrative,thesis");
  assert.equal(parsePublic(publicSample, ["http://127.0.0.1/secret", "http://192.168.1.9/a"]), null);
  assert.equal(parsePublic(publicSample, []), null);
});
