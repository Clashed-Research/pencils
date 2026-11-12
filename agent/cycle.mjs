// Shared hourly gate for the external runners. It does not call a model.

import { readFile, writeFile } from "node:fs/promises";
import { HOUR_MS, shouldRun, slotsLeft, waitMs } from "./narratives.mjs";

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function readSeen(seenPath) {
  try {
    const parsed = JSON.parse(await readFile(seenPath, "utf8"));
    return {
      at: Number(parsed.at || 0),
      published: Array.isArray(parsed.published) ? parsed.published : [],
    };
  } catch {
    return { at: 0, published: [] };
  }
}

export async function writeSeen(seenPath, seen, now = Date.now()) {
  const published = (seen.published || []).filter((row) => now - Number(row.at || 0) < 2 * 24 * HOUR_MS);
  await writeFile(seenPath, JSON.stringify({ at: seen.at || 0, published }, null, 2));
}

export async function publishListing(site, token, listing) {
  const published = await fetch(`${site}/api/agent/markets`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      title: listing.title,
      days: listing.days,
      sourceUrl: listing.sourceUrl,
      sourceLabel: listing.sourceLabel,
      narrative: listing.narrative,
      role: listing.role,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = await published.json().catch(() => ({}));
  if (!published.ok) throw new Error(result.error || `Pencils ${published.status}`);
  return result;
}

export function listingNote(parsed, slots, listings) {
  if (!(slots >= 2 && parsed?.market && parsed?.thesis)) {
    if (slots === 1 && parsed?.market && parsed?.thesis && parsed.market.title !== parsed.thesis.title) {
      return "One daily slot left, so only the thesis market was listed";
    }
    return "";
  }
  if (parsed.market.title === parsed.thesis.title) return "The narrative and the thesis were the same sentence, so one market was listed";
  if (listings.length < 2) return "The narrative and the thesis were too similar, so one market was listed";
  return "";
}

export async function runHour(seenPath, interval, gather) {
  const seen = await readSeen(seenPath);
  const now = Date.now();
  if (!shouldRun(seen, now, interval)) return waitMs(seen, now, interval);
  seen.at = now;
  await writeSeen(seenPath, seen, now);
  try {
    const slots = slotsLeft(seen.published, now);
    if (slots <= 0) {
      console.log("This agent already opened 6 markets in the last 24 hours");
      return interval;
    }
    const prepared = await gather(slots);
    for (const listing of prepared?.listings || []) {
      const result = await publishListing(prepared.site, prepared.token, listing);
      seen.published.push({ at: Date.now(), id: result.marketId, role: listing.role });
      await writeSeen(seenPath, seen);
      console.log(`Listed ${listing.role} ${result.marketId} on ${prepared.site}`);
    }
    if (prepared?.note) console.log(prepared.note);
  } catch (err) {
    console.error(err.message || err);
  }
  return interval;
}
