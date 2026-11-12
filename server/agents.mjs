import { propose, scoreThesis, withLedger } from "../engine/book.mjs";

const DEADLINE = /(within|by |before|until|end of|this week|next week|tomorrow|today|in \d+|q[1-4]|20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const SOURCE = /(on x|price|volume|chart|leaderboard|index|report|data|close|trend|supply|announce|release|launch|poll|sales|tvl|users|transaction)/i;

function deskQuote(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  if (x >= 15 && x <= 85) return Math.round(x) / 100;
  if (x >= 0.15 && x <= 0.85) return Math.round(x * 100) / 100;
  return null;
}

export function parseDraft(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let json;
  try {
    json = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  const title = String(json.title || "").replace(/\s+/g, " ").trim();
  const days = [1, 7, 30].includes(Number(json.days)) ? Number(json.days) : 7;
  if (!title) return null;
  const deepen = [20, 40, 80].includes(Number(json.deepen)) ? Number(json.deepen) : 0;
  const counter = json.counter === true || json.counter === "true";
  return { title, days, quote: deskQuote(json.quote), deepen, counter };
}

export function parseVerdict(text) {
  const raw = String(text || "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return "unsure";
  try {
    const json = JSON.parse(raw.slice(start, end + 1));
    const outcome = String(json.outcome || "").toLowerCase();
    if (outcome === "yes" || outcome === "no" || outcome === "unsure") return outcome;
  } catch {
    return "unsure";
  }
  return "unsure";
}

export function publicSourceUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return "";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) return "";
  if (host.includes(":")) return "";
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) {
      return "";
    }
  }
  return url.toString().slice(0, 200);
}

export function hardenThesis(title) {
  let t = String(title || "").replace(/\s+/g, " ").trim();
  if (!/\d|%|\$/.test(t)) t = `${t} by at least 1 measure`;
  if (!DEADLINE.test(t)) t = `${t} before December 2026`;
  if (!SOURCE.test(t)) t = `${t}, checked against the source report`;
  if (t.length < 30) t = `${t} Agents will settle it from the source.`;
  if (t.length > 180) t = `${t.slice(0, 176).replace(/[, ]+$/, "")}.`;
  return t;
}

function watchHits(watch, text) {
  const words = String(watch || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2);
  if (!words.length) return false;
  const blob = text.toLowerCase();
  return words.some((w) => blob.includes(w));
}

export function choosePublisher(users, text) {
  for (const user of users) {
    for (const agent of user.agents || []) {
      if (!agent.perms?.propose) continue;
      if (watchHits(agent.watch, text)) return { user, agent };
    }
  }
  return null;
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString().slice(0, 200);
  } catch {
    return "";
  }
}

const KNOWN_SOURCES = {
  "btc-150": "https://www.coingecko.com/en/coins/bitcoin",
  "open-weights": "https://lmarena.ai/leaderboard",
  "ai-hot100": "https://www.billboard.com/charts/hot-100/",
};

export function attachKnownSources(book) {
  let changed = false;
  for (const market of book.markets || []) {
    const url = KNOWN_SOURCES[market.id];
    if (!url || market.feedUrl) continue;
    market.feedUrl = url;
    if (market.crit && !market.crit.includes(url)) market.crit = `${market.crit} Follow ${url}.`;
    changed = true;
  }
  return changed;
}

export function publishDraft(book, users, draft, post, now = Date.now()) {
  const title = hardenThesis(draft.title);
  if (!scoreThesis(title).ok) throw new Error("Quorum rejected the agent draft");
  const url = safeHttpUrl(post.url);
  if (!url) throw new Error("Quorum rejected this thesis. It has no source to follow.");
  const kind = post.source === "x" ? "X" : post.source === "reddit" ? "Reddit" : "News";
  const source = {
    src: [post.source === "x" ? "x" : "news", `${kind}: ${post.title}`.slice(0, 90)],
    url,
  };
  book.seenFeeds = book.seenFeeds || [];
  if (!book.seenFeeds.includes(post.id)) book.seenFeeds.push(post.id);
  book.seenFeeds = book.seenFeeds.slice(-400);
  const hosted = choosePublisher(users, `${post.title} ${draft.title}`);
  if (hosted) {
    return withLedger(book, hosted.user, () =>
      propose(book, { title, days: draft.days, by: hosted.agent.id, now, source }),
    );
  }
  return propose(book, { title, days: draft.days, by: "pulse", now, source });
}
