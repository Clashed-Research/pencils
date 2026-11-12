// One Grok responses call. The operator pays for XAI_API_KEY. Pencils' NEAR AI key is not read.

import { grokText } from "./narratives.mjs";

export const XAI_RESPONSES = "https://api.x.ai/v1/responses";
export const DEFAULT_MODEL = "grok-4.7";

export async function askGrok({ key, model, prompt, tools }) {
  const res = await fetch(XAI_RESPONSES, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      input: [{ role: "user", content: prompt }],
      tools,
      max_turns: 2,
      temperature: 0.2,
      max_output_tokens: 700,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Grok ${res.status}: ${body.slice(0, 180)}`);
  }
  return grokText(await res.json());
}
