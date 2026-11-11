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
            "You write the one-sentence encyclopedia page for a prediction market. Plain English. No hashtags. Include the literal token {p} where the Yes percent should be inserted. One sentence only.",
        },
        {
          role: "user",
          content: `Thesis: ${title}\nYes probability: ${probability}%\nResolution: ${criteria}`,
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
      max_tokens: 160,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "system",
          content:
            'Turn one social post into a Yes/No prediction. Reply with JSON only: {"title":"...","days":7}. days is 1, 7, or 30. The title is one sentence of 40 to 160 characters. It must include a number, the word before or a month, and one of: price, report, launch, data. No hashtags.',
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
