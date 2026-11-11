import { propose, scoreThesis, withLedger } from "../engine/book.mjs";

const DEADLINE = /(within|by |before|until|end of|this week|next week|tomorrow|today|in \d+|q[1-4]|20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i;
const SOURCE = /(on x|price|volume|chart|leaderboard|index|report|data|close|trend|supply|announce|release|launch|poll|sales|tvl|users|transaction)/i;

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
  return { title, days };
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

export function publishDraft(book, users, draft, post, now = Date.now()) {
  const title = hardenThesis(draft.title);
  if (!scoreThesis(title).ok) throw new Error("Quorum rejected the agent draft");
  const source = {
    src: [post.source === "x" ? "x" : "news", `${post.source === "x" ? "X" : post.source === "reddit" ? "Reddit" : "News"}: ${post.title}`.slice(0, 90)],
    url: post.url || "",
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
