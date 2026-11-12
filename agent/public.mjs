// External Pencils agent. Once an hour it asks Grok to search the public web
// for a hot narrative, then lists a narrative market and a thesis market.
// Sources must be pages Grok cited. The operator pays for XAI_API_KEY.
// Pencils' NEAR AI key is not read. This token is separate from the X agent.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { listingNote, runHour, sleep } from "./cycle.mjs";
import { askGrok, DEFAULT_MODEL } from "./grok.mjs";
import { chooseListings, HOUR_MS, parsePublic, publicPrompt } from "./narratives.mjs";

const site = (process.env.PENCILS_URL || "https://pencils.buzz").replace(/\/$/, "");
const token = process.env.PENCILS_PUBLIC_TOKEN || "";
const grokKey = process.env.XAI_API_KEY || "";
const model = process.env.XAI_MODEL || DEFAULT_MODEL;
const once = process.env.AGENT_ONCE === "1";
const interval = Math.max(60_000, Number(process.env.AGENT_INTERVAL_MS || HOUR_MS) || HOUR_MS);
const seenPath = path.join(path.dirname(fileURLToPath(import.meta.url)), ".seen-public.json");

if (!token.startsWith("pk_")) {
  console.error("Set PENCILS_PUBLIC_TOKEN from a second Pencils plug-in. Do not reuse the X agent token.");
  process.exit(1);
}
if (!grokKey) {
  console.error("Set XAI_API_KEY. Pencils does not spend its NEAR AI key on a plugged-in agent.");
  process.exit(1);
}

async function gather(slots) {
  const { text, citations } = await askGrok({
    key: grokKey,
    model,
    prompt: publicPrompt(),
    tools: [{ type: "web_search" }],
  });
  const parsed = parsePublic(text, citations);
  if (!parsed) throw new Error("Grok did not return a narrative bound to a cited page");
  const listings = chooseListings(parsed, slots);
  if (!listings.length) throw new Error("No distinct market came back");
  return { listings, site, token, note: listingNote(parsed, slots, listings) };
}

console.log(`Hourly public agent searching the web with Grok every ${Math.round(interval / 60000)} min`);
if (once) {
  await runHour(seenPath, interval, gather);
} else {
  for (;;) {
    const wait = await runHour(seenPath, interval, gather);
    if (wait > 0) console.log(`Next public check in ${Math.ceil(wait / 60000)} min`);
    await sleep(wait || interval);
  }
}
