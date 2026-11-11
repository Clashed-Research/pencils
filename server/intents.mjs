// NEAR Intents 1Click quotes. dry: true never creates a deposit address and never moves funds.
// Asset ids were read from https://1click.chaindefuser.com/v0/tokens on 2026-11-11.

const QUOTE_URL = "https://1click.chaindefuser.com/v0/quote";

export const ASSETS = {
  nearUsdc: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  ethUsdc: "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
  solUsdc: "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near",
  baseUsdc: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
  arbUsdc: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
};

const ORIGINS = {
  eth: ASSETS.ethUsdc,
  sol: ASSETS.solUsdc,
  base: ASSETS.baseUsdc,
  arb: ASSETS.arbUsdc,
  near: ASSETS.nearUsdc,
};

// 1Click rejects the zero and burn addresses. These are the public sample
// addresses from the 1Click docs. dry is always true, so nothing is sent to them.
const DRY_EVM = "0x2527D02599Ba641c19FEa793cD0F167589a0f10D";
const DRY_SOL = "13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK";

function dryChainAddress(chain) {
  return chain === "sol" ? DRY_SOL : DRY_EVM;
}

export function originAsset(chain) {
  return ORIGINS[chain] || ORIGINS.eth;
}

export async function quoteUsdc({ amountUsd, chain = "eth", direction = "deposit", recipient, refundTo }) {
  const usd = Number(amountUsd);
  if (!Number.isFinite(usd) || usd <= 0) throw new Error("Amount must be positive");
  const amount = String(Math.round(usd * 1e6));
  const near = recipient || process.env.NEAR_ACCOUNT_ID || "intents.near";
  const chainAddress = refundTo || dryChainAddress(chain);
  const incoming = direction !== "withdraw";
  const body = {
    dry: true,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: incoming ? originAsset(chain) : ASSETS.nearUsdc,
    destinationAsset: incoming ? ASSETS.nearUsdc : originAsset(chain),
    amount,
    depositType: incoming ? "ORIGIN_CHAIN" : "INTENTS",
    recipient: incoming ? near : chainAddress,
    recipientType: incoming ? "INTENTS" : "DESTINATION_CHAIN",
    refundTo: incoming ? chainAddress : near,
    refundType: incoming ? "ORIGIN_CHAIN" : "INTENTS",
    deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  };
  const headers = { "content-type": "application/json" };
  if (process.env.NEAR_INTENTS_JWT) headers["X-API-Key"] = process.env.NEAR_INTENTS_JWT;
  const res = await fetch(QUOTE_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    const message = json?.message || json?.error || text.slice(0, 240);
    throw new Error(`NEAR Intents quote failed (${res.status}): ${message}`);
  }
  const q = json.quote || {};
  return {
    dry: true,
    chain,
    direction,
    amountIn: amount,
    amountInUsd: q.amountInUsd || null,
    amountOut: q.amountOut || null,
    amountOutFormatted: q.amountOutFormatted || null,
    amountOutUsd: q.amountOutUsd || null,
    timeEstimate: q.timeEstimate || null,
    correlationId: json.correlationId || null,
  };
}
