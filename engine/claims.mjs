// Similarity for market titles and write-ups. Same source page is allowed.
// A close rewrite of a title or a write-up is a repeat, whoever lists it.

const STOP = new Set(
  "a an the of on in to for and or by at from with this that is are be before after within until its any than then into over under about as if not no yes will can".split(" "),
);

export const SIMILAR_CLAIM = 0.55;

export function claimTokens(text) {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/\[\[|\]\]/g, " ")
    .replace(/(\d[\d,]*)\s*([km])\b/g, (_, n, unit) => {
      const digits = n.replace(/,/g, "");
      const scale = unit === "k" ? 1000 : 1_000_000;
      return String(Number(digits) * scale);
    })
    .replace(/[^a-z0-9]+/g, " ");
  return [...new Set(raw.split(/\s+/).filter((word) => word.length > 1 && !STOP.has(word)))];
}

export function claimSimilarity(a, b) {
  const left = claimTokens(a);
  const right = claimTokens(b);
  if (left.length < 3 || right.length < 3) return 0;
  const rightSet = new Set(right);
  let shared = 0;
  for (const token of left) if (rightSet.has(token)) shared += 1;
  return shared / (left.length + right.length - shared);
}

export function repeatsClaim(existingTitle, existingWrite, title, narrative) {
  if (claimSimilarity(title, existingTitle) >= SIMILAR_CLAIM) return true;
  const write = String(narrative || "").trim();
  const prior = String(existingWrite || "").trim();
  if (write.length >= 12 && prior.length >= 12 && claimSimilarity(write, prior) >= SIMILAR_CLAIM) return true;
  if (write.length >= 12 && claimSimilarity(write, existingTitle) >= SIMILAR_CLAIM) return true;
  if (prior.length >= 12 && claimSimilarity(title, prior) >= SIMILAR_CLAIM) return true;
  return false;
}
