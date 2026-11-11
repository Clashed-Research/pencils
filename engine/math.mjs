// Binary CPMM used by the Pencils server and mirrored in contract/src/lib.rs.
//
// A market starts with equal YES and NO reserves and the same amount of
// collateral. Buying YES mints a complete set (pay `net` USDC, receive `net`
// YES and `net` NO) and sells the NO into the pool. Floor division is exact:
// pool_yes + yes_liabilities == collateral, and the same for NO.
//
// Amounts are integer micro-USDC (6 decimals). One winning share pays 1_000_000.

export const SCALE = 1_000_000n;
export const FEE_BPS = 50n;
export const LIQ = 800n * SCALE;
export const MIN_PRICE = 0.02;
export const MAX_PRICE = 0.98;

export function spot(yes, no) {
  const den = yes + no;
  if (den === 0n) return 0.5;
  return Number(no) / Number(den);
}

export function applyBuy(yes, no, budget, side) {
  if (budget <= 0n) throw new Error("Amount must be positive");
  if (side !== "yes" && side !== "no") throw new Error("Side must be yes or no");
  const fee = (budget * FEE_BPS) / 10_000n;
  const net = budget - fee;
  if (net <= 0n) throw new Error("Amount is below the minimum");
  const k = yes * no;
  if (side === "yes") {
    const newNo = no + net;
    const newYes = k / newNo;
    if (newYes === 0n || newYes >= yes) throw new Error("Not enough liquidity");
    const shares = net + (yes - newYes);
    return { yes: newYes, no: newNo, shares, fee, net };
  }
  const newYes = yes + net;
  const newNo = k / newYes;
  if (newNo === 0n || newNo >= no) throw new Error("Not enough liquidity");
  const shares = net + (no - newNo);
  return { yes: newYes, no: newNo, shares, fee, net };
}

export function usdToMicro(usd) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n <= 0) throw new Error("Amount must be positive");
  return BigInt(Math.round(n * 1e6));
}

export function microToUsd(micro) {
  return Number(micro) / 1e6;
}

export function freshPool() {
  return {
    yes: LIQ,
    no: LIQ,
    collateral: LIQ,
    yesLiab: 0n,
    noLiab: 0n,
    fees: 0n,
  };
}

export function commitPool(pool, side, budget) {
  const next = applyBuy(pool.yes, pool.no, budget, side);
  pool.yes = next.yes;
  pool.no = next.no;
  pool.collateral += next.net;
  pool.fees += next.fee;
  if (side === "yes") pool.yesLiab += next.shares;
  else pool.noLiab += next.shares;
  if (pool.yes + pool.yesLiab !== pool.collateral) {
    throw new Error("YES solvency broken");
  }
  if (pool.no + pool.noLiab !== pool.collateral) {
    throw new Error("NO solvency broken");
  }
  return next;
}

// Move a fresh or live pool toward `target` by having the house take the other side of the book.
export function seedTo(pool, target) {
  const clamped = Math.min(MAX_PRICE, Math.max(MIN_PRICE, target));
  let budget = 20n * SCALE;
  for (let i = 0; i < 48; i++) {
    const p = spot(pool.yes, pool.no);
    if (Math.abs(p - clamped) < 0.004) return p;
    const side = clamped > p ? "yes" : "no";
    let step = budget;
    let preview = null;
    while (step >= SCALE) {
      try {
        preview = applyBuy(pool.yes, pool.no, step, side);
      } catch {
        step /= 2n;
        continue;
      }
      const nextP = spot(preview.yes, preview.no);
      const over = side === "yes" ? nextP > clamped + 0.008 : nextP < clamped - 0.008;
      if (over) {
        step /= 2n;
        preview = null;
        continue;
      }
      break;
    }
    if (!preview || step < SCALE) return spot(pool.yes, pool.no);
    commitPool(pool, side, step);
    if (step === budget && budget < 2_000n * SCALE) budget = (budget * 3n) / 2n;
  }
  return spot(pool.yes, pool.no);
}
