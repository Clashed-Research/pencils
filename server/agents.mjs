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

// Reasoning models emit their chain of thought and may echo the prompt's
// example JSON. Yield balanced {...} objects from the end of the text so the
// caller can take the model's final answer, not an echoed placeholder.
function* jsonObjects(raw) {
  const s = String(raw || "");
  let depth = 0;
  let end = -1;
  for (let i = s.length - 1; i >= 0; i--) {
    const c = s[i];
    if (c === "}") {
      if (depth === 0) end = i;
      depth += 1;
    } else if (c === "{" && depth > 0) {
      depth -= 1;
      if (depth === 0 && end >= 0) {
        yield s.slice(i, end + 1);
        end = -1;
      }
    }
  }
}

function lastValidJson(raw, ok) {
  for (const chunk of jsonObjects(raw)) {
    let obj;
    try {
      obj = JSON.parse(chunk);
    } catch {
      continue;
    }
    if (ok(obj)) return obj;
  }
  return null;
}

function realTitle(value) {
  return String(value || "").replace(/[.\s…·•\-–—:;,]/g, "").length > 0;
}

export function parseDraft(text) {
  const json = lastValidJson(text, (o) => o && typeof o.title === "string" && realTitle(o.title));
  if (!json) return null;
  const title = String(json.title || "").replace(/\s+/g, " ").trim();
  if (!title) return null;
  const days = [1, 7, 30].includes(Number(json.days)) ? Number(json.days) : 7;
  const deepen = [20, 40, 80].includes(Number(json.deepen)) ? Number(json.deepen) : 0;
  const counter = json.counter === true || json.counter === "true";
  return { title, days, quote: deskQuote(json.quote), deepen, counter };
}

export function parseVerdict(text) {
  const json = lastValidJson(text, (o) => o && ["yes", "no", "unsure"].includes(String(o.outcome || "").toLowerCase()));
  return json ? String(json.outcome).toLowerCase() : "unsure";
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
  // A draft must carry a real subject of its own. Stripping any leading
  // ellipsis or punctuation, it needs at least four word-tokens and 15+
  // letters; otherwise padding boilerplate onto an empty or "…" title would
  // mint a meaningless entry. Return "" so scoreThesis rejects it upstream.
  const subject = t.replace(/^[\s.…·•\-–—:;,]+/, "").trim();
  const words = subject.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  if (words.length < 4 || subject.replace(/[^a-z]/gi, "").length < 15) return "";
  t = subject;
  if (!/\d|%|\$/.test(t)) t = `${t} by at least 1 measure`;
  if (!DEADLINE.test(t)) t = `${t} before December 2026`;
  if (!SOURCE.test(t)) t = `${t}, checked against the source report`;
  if (t.length < 30) t = `${t} The swarm settles it from the source.`;
  if (t.length > 180) t = `${t.slice(0, 176).replace(/[, ]+$/, "")}.`;
  return t;
}

export function publishFromAgent(book, user, agent, body, now = Date.now()) {
  if (!agent?.perms?.propose) throw new Error("That agent cannot publish");
  const url = publicSourceUrl(body?.sourceUrl);
  if (!url) throw new Error("The thesis needs a public http source");
  const title = hardenThesis(body?.title);
  if (!scoreThesis(title).ok) throw new Error("Quorum rejected the agent draft");
  const days = [1, 7, 30].includes(Number(body?.days)) ? Number(body.days) : 7;
  const role = body?.role === "thesis" ? "thesis" : body?.role === "narrative" ? "narrative" : "";
  const narrative = String(body?.narrative || "").replace(/\s+/g, " ").trim().slice(0, 180);
  const recent = book.markets.filter((m) => m.by === agent.id && now - Number(m.created || 0) < 86400000).length;
  if (recent >= 6) throw new Error("This agent already opened 6 markets today");
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "";
  }
  const kind = host === "x.com" || host.endsWith(".x.com") ? "x" : "news";
  const label = String(body?.sourceLabel || (kind === "x" ? "X" : "Source")).replace(/\s+/g, " ").trim().slice(0, 90);
  return withLedger(book, user, () =>
    propose(book, {
      title,
      days,
      by: agent.id,
      now,
      narrative,
      role,
      source: { src: [kind, label], url },
    }),
  );
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
  return propose(book, { title, days: draft.days, by: "pulse", now, source });
}
