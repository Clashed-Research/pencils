// Optional NEAR AI Cloud call. With no key, callers keep the template summary.

const URL = "https://cloud-api.near.ai/v1/chat/completions";

export function aiEnabled() {
  return Boolean(process.env.NEAR_AI_API_KEY);
}

function messageText(json) {
  const msg = json?.choices?.[0]?.message || {};
  const content = typeof msg.content === "string" ? msg.content.trim() : "";
  if (content) return content;
  return typeof msg.reasoning_content === "string" ? msg.reasoning_content.trim() : "";
}

export async function writeConsensus({ title, probability, criteria }) {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) return null;
  const model = process.env.NEAR_AI_MODEL || "z-ai/glm-5.2";
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      max_tokens: 120,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "system",
          content:
            "You write the one-sentence encyclopedia entry for a sourced claim. Plain English. No hashtags. Include the literal token {p} where the swarm's live Yes confidence should be inserted. One sentence only.",
        },
        {
          role: "user",
          content: `Sentence: ${title}\nDesk quote, Yes: ${probability}%\nSource check: ${criteria}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NEAR AI ${res.status}: ${body.slice(0, 180)}`);
  }
  const json = await res.json();
  const text = messageText(json);
  if (!text) throw new Error("NEAR AI returned an empty page");
  return text.replace(/^["']|["']$/g, "").split("\n")[0].slice(0, 420);
}

export async function draftThesis({ title, source }) {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) return null;
  const model = process.env.NEAR_AI_MODEL || "z-ai/glm-5.2";
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 320,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "system",
          content:
            'You are the Pencils desk. Turn one post into a sentence a person can check at that post\'s public source, plus a standing quote. Reply with JSON only, no markdown: {"title":"...","days":7,"quote":0.5,"deepen":40,"counter":false}. days is 1, 7, or 30. The title is one sentence of 40 to 160 characters. It must include a number, a deadline (before, by, or a month), and the record to open (price, report, leaderboard, index, chart, or data). Name only a source the post itself points at. quote is your Yes quote from 0.15 to 0.85; use 0.5 when you do not lean. deepen is two-sided book liquidity and must be 0, 20, 40, or 80. counter is true only when a serious reading of the same source would write the other sentence. No hashtags.',
        },
        {
          role: "user",
          content: `Source: ${source}\nPost: ${String(title || "").slice(0, 400)}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NEAR AI ${res.status}: ${body.slice(0, 180)}`);
  }
  const json = await res.json();
  const text = messageText(json);
  if (!text) {
    const msg = json?.choices?.[0]?.message || {};
    const finish = json?.choices?.[0]?.finish_reason || "none";
    throw new Error(`NEAR AI returned an empty draft (${finish}, content ${String(msg.content || "").length})`);
  }
  return text;
}

export async function readSource({ title, criteria, page }) {
  const key = process.env.NEAR_AI_API_KEY;
  if (!key) return null;
  const model = process.env.NEAR_AI_MODEL || "z-ai/glm-5.2";
  const res = await fetch(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 80,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "system",
          content:
            'You check one public page against one sentence. Reply with JSON only: {"outcome":"yes"} or {"outcome":"no"} or {"outcome":"unsure"}. Use yes or no only when the page states the fact. If the page is missing, old, or unclear, use unsure. The live number is not evidence.',
        },
        {
          role: "user",
          content: `Sentence: ${String(title || "").slice(0, 240)}\nHow to check: ${String(criteria || "").slice(0, 400)}\nPage: ${String(page || "").slice(0, 3500)}`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`NEAR AI ${res.status}: ${body.slice(0, 180)}`);
  }
  const json = await res.json();
  const text = messageText(json);
  if (!text) throw new Error("NEAR AI returned an empty source read");
  return text;
}
