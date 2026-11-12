// External Pencils agent. Once an hour it reads the X API, asks Grok with X search
// which narrative is hot, and lists a narrative market plus a thesis market.
// The operator pays for X_BEARER_TOKEN and XAI_API_KEY. Pencils' NEAR AI key is not read.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { listingNote, runHour, sleep } from "./cycle.mjs";
import { askGrok, DEFAULT_MODEL } from "./grok.mjs";
import { chooseListings, HOUR_MS, parseNarrative, postsFromXApi, trendQuery, xPrompt } from "./narratives.mjs";

const site = (process.env.PENCILS_URL || "https://pencils.buzz").replace(/\/$/, "");
const token = process.env.PENCILS_AGENT_TOKEN || "";
const xKey = process.env.X_BEARER_TOKEN || "";
const grokKey = process.env.XAI_API_KEY || "";
const model = process.env.XAI_MODEL || DEFAULT_MODEL;
const once = process.env.AGENT_ONCE === "1";
const interval = Math.max(60_000, Number(process.env.AGENT_INTERVAL_MS || HOUR_MS) || HOUR_MS);
const seenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".seen.json");

function woeid() {
  const raw = String(process.env.X_TRENDS_WOEID || "1").trim();
  return /^[1-9]\d{0,8}$/.test(raw) ? raw : "1";
}

if (!token.startsWith("pk_")) {
  console.error("Set PENCILS_AGENT_TOKEN from the Pencils plug-in sheet. Use a different token from the public agent.");
  process.exit(1);
}
if (!xKey) {
  console.error("Set X_BEARER_TOKEN. This agent reads the X API. It is not pinned to an account.");
  process.exit(1);
}
if (!grokKey) {
  console.error("Set XAI_API_KEY. Pencils does not spend its NEAR AI key on a plugged-in agent.");
  process.exit(1);
}

function dayStamp(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

async function xJson(url) {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${xKey}`, accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`X API ${res.status}: ${body.slice(0, 160)}`);
  }
  return res.json();
}

async function loadPosts() {
  const trends = await xJson(
    `https://api.x.com/2/trends/by/woeid/${woeid()}?max_trends=10&trend.fields=trend_name,tweet_count`,
  );
  const picked = postsFromXApi(trends, null);
  const query = trendQuery(picked.trend?.name);
  if (!query) return [];
  const params = new URLSearchParams({
    query,
    max_results: "10",
    "tweet.fields": "created_at,public_metrics,lang",
    expansions: "author_id",
    "user.fields": "username",
  });
  const search = await xJson(`https://api.x.com/2/tweets/search/recent?${params}`);
  return postsFromXApi(trends, search).posts;
}

async function gather(slots) {
  const posts = await loadPosts();
  if (!posts.length) throw new Error("No usable X posts this hour");
  const today = Date.now();
  const { text } = await askGrok({
    key: grokKey,
    model,
    prompt: xPrompt(posts),
    tools: [{ type: "x_search", from_date: dayStamp(today - 86_400_000), to_date: dayStamp(today) }],
  });
  const parsed = parseNarrative(text, posts);
  if (!parsed) throw new Error("Grok did not return a narrative bound to an X post");
  const listings = chooseListings(parsed, slots);
  if (!listings.length) throw new Error("No distinct market came back");
  return { listings, site, token, note: listingNote(parsed, slots, listings) };
}

console.log(`Hourly X agent reading the X API and asking Grok every ${Math.round(interval / 60000)} min`);
if (once) {
  await runHour(seenPath, interval, gather);
} else {
  for (;;) {
    const wait = await runHour(seenPath, interval, gather);
    if (wait > 0) console.log(`Next narrative check in ${Math.ceil(wait / 60000)} min`);
    await sleep(wait || interval);
  }
}
