// Live posts for hosted agents. X profiles come through the public Jina reader.
// Reddit and BBC are plain RSS. A failed source is skipped.

const X_HANDLES = (process.env.PENCILS_X_HANDLES || "NEARProtocol,Reuters")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const REDDIT = "https://www.reddit.com/r/technology/hot/.rss";
const NEWS = "https://feeds.bbci.co.uk/news/technology/rss.xml";

let cache = { at: 0, posts: [] };

function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36);
}

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1] : "";
}

export function postsFromRss(xml, source) {
  const posts = [];
  for (const m of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const title = decode(tag(m[1], "title"));
    const link = decode(tag(m[1], "link")).split(" ")[0];
    if (title.length < 12) continue;
    posts.push({
      id: `${source}:${hash(link || title)}`,
      source,
      title: title.slice(0, 220),
      url: link,
      text: title.slice(0, 220),
    });
    if (posts.length >= 5) break;
  }
  return posts;
}

export function postsFromX(handle, markdown) {
  const posts = [];
  const parts = String(markdown || "").split(/\n\*\s+/).slice(1);
  for (const chunk of parts) {
    const text = chunk
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/https?:\S+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length < 40) continue;
    const title = text.slice(0, 220);
    posts.push({
      id: `x:${handle}:${hash(title)}`,
      source: "x",
      title,
      url: `https://x.com/${handle}`,
      text: title,
    });
    if (posts.length >= 3) break;
  }
  return posts;
}

async function getText(url) {
  const res = await fetch(url, {
    headers: { "user-agent": "pencils/1.0", accept: "text/plain, application/rss+xml, */*" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export async function loadFeeds(now = Date.now()) {
  const ttl = Math.max(60_000, Number(process.env.FEED_TTL_MS || 10 * 60 * 1000));
  if (cache.posts.length && now - cache.at < ttl) return cache.posts;
  const jobs = [
    getText(REDDIT)
      .then((xml) => postsFromRss(xml, "reddit"))
      .catch(() => getText("https://old.reddit.com/r/technology/hot/.rss").then((xml) => postsFromRss(xml, "reddit")))
      .catch(() => []),
    getText(NEWS).then((xml) => postsFromRss(xml, "news")).catch(() => []),
    ...X_HANDLES.map((handle) =>
      getText(`https://r.jina.ai/https://x.com/${handle}`)
        .then((md) => postsFromX(handle, md))
        .catch(() => []),
    ),
  ];
  const groups = await Promise.all(jobs);
  const posts = groups.flat().filter((p) => p && p.id && p.title);
  if (posts.length) cache = { at: now, posts };
  return cache.posts;
}
