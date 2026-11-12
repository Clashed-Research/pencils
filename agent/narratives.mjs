// Pure helpers for the hourly agents. No network and no model calls.
// The X agent reads the X API. It is not pinned to accounts.
// The public agent binds a market only to a page Grok actually cited.

import { claimSimilarity, SIMILAR_CLAIM } from "../engine/claims.mjs";
import { publicSourceUrl } from "../server/agents.mjs";

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
export const DAILY_CAP = 6;

export function trendQuery(name) {
  const raw = String(name || "").replace(/\s+/g, " ").trim();
  const hash = raw.match(/^#([\p{L}\p{N}_]{1,50})$/u);
  if (hash) return `#${hash[1]} -is:retweet`;
  const cleaned = raw.replace(/["\\]/g, "").replace(/[^\p{L}\p{N}\s._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (cleaned.length < 2) return "";
  const phrase = /\s/.test(cleaned) ? `"${cleaned}"` : cleaned;
  return `${phrase} -is:retweet`;
}

export function hottestTrend(trendsJson) {
  const rows = Array.isArray(trendsJson?.data) ? trendsJson.data : [];
  let best = null;
  let bestCount = -1;
  for (const row of rows) {
    const name = String(row?.trend_name || "").replace(/\s+/g, " ").trim();
    if (name.length < 2) continue;
    const count = Number(row?.tweet_count);
    const n = Number.isFinite(count) && count >= 0 ? count : -1;
    if (!best || n > bestCount) {
      best = { name, count: n };
      bestCount = n;
    }
  }
  return best;
}

export function postsFromSearch(searchJson, trend, limit = 10) {
  const users = new Map();
  for (const user of searchJson?.includes?.users || []) {
    if (user?.id && user?.username) users.set(String(user.id), String(user.username));
  }
  const posts = [];
  const trendName = trend?.name || "";
  for (const tweet of searchJson?.data || []) {
    const id = String(tweet?.id || "");
    const username = users.get(String(tweet?.author_id || "")) || "";
    if (!/^\d+$/.test(id) || !/^[A-Za-z0-9_]{1,15}$/.test(username)) continue;
    const text = String(tweet?.text || "").replace(/\s+/g, " ").trim();
    if (text.length < 8) continue;
    const likes = Number(tweet?.public_metrics?.like_count);
    const likeBit = Number.isFinite(likes) ? `, ${likes} likes` : "";
    posts.push({
      id,
      source: "x",
      trend: trendName,
      title: text.slice(0, 140),
      text: `@${username}${likeBit}: ${text}`.slice(0, 320),
      url: `https://x.com/${username}/status/${id}`,
      label: `X @${username}`.slice(0, 90),
    });
    if (posts.length >= limit) break;
  }
  return posts;
}

export function postsFromXApi(trendsJson, searchJson, limit = 10) {
  const trend = hottestTrend(trendsJson);
  return { trend, posts: postsFromSearch(searchJson, trend, limit) };
}

export function shouldRun(seen, now, interval = HOUR_MS) {
  const last = Number(seen?.at || 0);
  if (!last) return true;
  return now - last >= interval;
}

export function waitMs(seen, now, interval = HOUR_MS) {
  const last = Number(seen?.at || 0);
  if (!last) return 0;
  return Math.max(0, last + interval - now);
}

export function slotsLeft(published, now, cap = DAILY_CAP, windowMs = DAY_MS) {
  const recent = (published || []).filter((row) => now - Number(row?.at || 0) < windowMs);
  return Math.max(0, cap - recent.length);
}

function listing(node, role, posts, narrative) {
  if (!node || typeof node !== "object") return null;
  const title = String(node.title || "").replace(/\s+/g, " ").trim();
  if (title.length < 20 || title.length > 180) return null;
  const days = [1, 7, 30].includes(Number(node.days)) ? Number(node.days) : 7;
  const post = posts[Number(node.post)];
  if (!post || !/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/\d+$/.test(String(post.url || ""))) return null;
  const writeup = String(node.writeup || "").replace(/\s+/g, " ").trim();
  const narrativeLine = (writeup.length >= 12 ? writeup : narrative).slice(0, 160);
  const sourceLabel = String(post.label || "X").slice(0, 90);
  return {
    role,
    title,
    days,
    sourceUrl: String(post.url),
    sourceLabel,
    narrative: narrativeLine,
  };
}

function readJson(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function parseNarrative(text, posts) {
  const json = readJson(text);
  if (!json) return null;
  const narrative = String(json.narrative || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (narrative.length < 12) return null;
  const list = Array.isArray(posts) ? posts : [];
  const market = listing(json.market, "narrative", list, narrative);
  const thesis = listing(json.thesis, "thesis", list, narrative);
  if (!market && !thesis) return null;
  return { narrative, market, thesis };
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").slice(0, 90) || "Source";
  } catch {
    return "Source";
  }
}

function citedListing(node, role, allowed, narrative) {
  if (!node || typeof node !== "object") return null;
  const title = String(node.title || "").replace(/\s+/g, " ").trim();
  if (title.length < 20 || title.length > 180) return null;
  const sourceUrl = publicSourceUrl(node.sourceUrl);
  if (!sourceUrl || !allowed.has(sourceUrl)) return null;
  const days = [1, 7, 30].includes(Number(node.days)) ? Number(node.days) : 7;
  const writeup = String(node.writeup || "").replace(/\s+/g, " ").trim();
  return {
    role,
    title,
    days,
    sourceUrl,
    sourceLabel: hostLabel(sourceUrl),
    narrative: (writeup.length >= 12 ? writeup : narrative).slice(0, 160),
  };
}

export function parsePublic(text, citations) {
  const json = readJson(text);
  if (!json) return null;
  const narrative = String(json.narrative || "").replace(/\s+/g, " ").trim().slice(0, 160);
  if (narrative.length < 12) return null;
  const allowed = new Set();
  for (const raw of citations || []) {
    const url = publicSourceUrl(raw);
    if (url) allowed.add(url);
  }
  if (!allowed.size) return null;
  const market = citedListing(json.market, "narrative", allowed, narrative);
  const thesis = citedListing(json.thesis, "thesis", allowed, narrative);
  if (!market && !thesis) return null;
  return { narrative, market, thesis };
}

export function grokText(body) {
  const output = Array.isArray(body?.output) ? body.output : [];
  const parts = [];
  const citations = [];
  const add = (url) => {
    const value = String(url || "").trim();
    if (/^https?:\/\//i.test(value) && !citations.includes(value)) citations.push(value);
  };
  for (const item of output) {
    if (item?.type && item.type !== "message") continue;
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && block.text) parts.push(String(block.text));
      for (const note of block?.annotations || []) add(note?.url);
    }
  }
  if (!parts.length && typeof body?.output_text === "string") parts.push(body.output_text);
  for (const cite of body?.citations || []) add(typeof cite === "string" ? cite : cite?.url);
  return { text: parts.join("\n"), citations };
}

export function chooseListings(parsed, slots) {
  if (!parsed || slots <= 0) return [];
  const market = parsed.market;
  const thesis = parsed.thesis;
  const distinct =
    market &&
    thesis &&
    market.title !== thesis.title &&
    claimSimilarity(market.title, thesis.title) < SIMILAR_CLAIM &&
    claimSimilarity(market.narrative, thesis.narrative) < SIMILAR_CLAIM;
  if (slots >= 2 && distinct) return [market, thesis];
  if (thesis) return [thesis];
  if (market) return [market];
  return [];
}

export function xPrompt(posts) {
  const lines = posts.map((post, i) => `${i}. ${post.text}\nPost: ${post.url}`).join("\n");
  return `These posts were fetched from the X API this hour for one live trend. They are not one account. Use X search once to confirm the hottest narrative. Do not open threads. Do not open profiles. Reply with JSON only:
{"narrative":"one sentence, 12 to 160 characters, what is hot","market":{"title":"...","writeup":"...","days":7,"post":0},"thesis":{"title":"...","writeup":"...","days":7,"post":0}}
market is a checkable claim that this narrative is still loud on the cited post by the deadline.
thesis is a different checkable claim a person can verify on a cited post.
The two titles must not be paraphrases of each other. The two writeups must not be paraphrases of each other or of the titles.
Each title is 40 to 160 characters and includes a number, a deadline, and a word such as price, report, launch, data, or chart.
Each writeup is one sentence, 12 to 160 characters.
post is an index into the list below. days is 1, 7, or 30.
Do not invent a post, a count, or a figure that is not in the list. If a post has no number, the title may say "at least 1".
Posts:
${lines}`;
}

export function publicPrompt() {
  return `Search the public web once for the hottest checkable news narrative right now. Do not search X. Do not open more pages than you need to name the story. Reply with JSON only:
{"narrative":"one sentence, 12 to 160 characters, what is hot","market":{"title":"...","writeup":"...","days":7,"sourceUrl":"https://..."},"thesis":{"title":"...","writeup":"...","days":7,"sourceUrl":"https://..."}}
market is a checkable claim that this narrative is still the public story by the deadline.
thesis is a different checkable claim a person can verify on a cited page.
The two titles must not be paraphrases of each other. The two writeups must not be paraphrases of each other or of the titles.
Each title is 40 to 160 characters and includes a number, a deadline, and a word such as price, report, launch, data, or chart.
Each writeup is one sentence, 12 to 160 characters.
sourceUrl must be a page you actually opened. days is 1, 7, or 30.
Do not invent a page or a figure that is not on a cited page. If a page has no number, the title may say "at least 1".`;
}
