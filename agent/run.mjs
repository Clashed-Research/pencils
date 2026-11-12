// External Pencils agent. It uses the operator's Gemini key and public X pages.
// Pencils' NEAR AI key is not read and is not called.

import { parseDraft } from "../server/agents.mjs";
import { postsFromX } from "../server/feeds.mjs";

const site = (process.env.PENCILS_URL || "https://pencils.buzz").replace(/\/$/, "");
const token = process.env.PENCILS_AGENT_TOKEN || "";
const geminiKey = process.env.GEMINI_API_KEY || "";
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const handle = (process.env.X_HANDLES || "NEARProtocol").split(",")[0].trim();

if (!token.startsWith("pk_")) {
  console.error("Set PENCILS_AGENT_TOKEN from the Pencils plug-in sheet.");
  process.exit(1);
}
if (!geminiKey) {
  console.error("Set GEMINI_API_KEY. Pencils does not spend its NEAR AI key on a plugged-in agent.");
  process.exit(1);
}
if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
  console.error("X handle is not valid");
  process.exit(1);
}

const page = await fetch(`https://r.jina.ai/https://x.com/${handle}`, {
  headers: { accept: "text/plain", "user-agent": "pencils-agent/1.0" },
  signal: AbortSignal.timeout(20_000),
});
if (!page.ok) throw new Error(`X feed ${page.status}`);
const posts = postsFromX(handle, await page.text());
const post = posts[0];
if (!post) {
  console.log(`No usable post from @${handle}`);
  process.exit(0);
}

const draftRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-goog-api-key": geminiKey },
  body: JSON.stringify({
    generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: "application/json" },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `You write one sentence a person can check at this X page. Reply with JSON only: {"title":"...","days":7}. days is 1, 7, or 30. The title is 40 to 160 characters and includes a number, a deadline, and the record the post itself names. Do not invent a different source.\nPost: ${post.text}\nPage: ${post.url}`,
          },
        ],
      },
    ],
  }),
  signal: AbortSignal.timeout(30_000),
});
if (!draftRes.ok) {
  const body = await draftRes.text();
  throw new Error(`Gemini ${draftRes.status}: ${body.slice(0, 180)}`);
}
const gemini = await draftRes.json();
const text = (gemini.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
const draft = parseDraft(text);
if (!draft) throw new Error("Gemini did not return a thesis");

const published = await fetch(`${site}/api/agent/markets`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({
    title: draft.title,
    days: draft.days,
    sourceUrl: post.url,
    sourceLabel: `X: @${handle}`,
  }),
  signal: AbortSignal.timeout(20_000),
});
const result = await published.json().catch(() => ({}));
if (!published.ok) throw new Error(result.error || `Pencils ${published.status}`);
console.log(`Listed ${result.marketId} from @${handle} on ${site}`);
