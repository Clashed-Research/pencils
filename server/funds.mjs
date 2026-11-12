import { bet, stake, withLedger } from "../engine/book.mjs";
import { usdToMicro } from "../engine/math.mjs";
import { agentKey, claimNearTx } from "./store.mjs";
import { contractId, fetchTx, signAndSend, usdFromMicro, viewAccessKey, viewFunds } from "./near.mjs";

function releaseKey() {
  return process.env.PENCILS_RELEASE_KEY || "";
}

export function requireAccount(user) {
  if (!user.accountId) throw new Error("Connect a NEAR wallet first");
}

export async function syncBalance(user) {
  const funds = await viewFunds(user.accountId);
  user.balance = Math.round((Number(funds.balance) / 1e6) * 100) / 100;
  return funds;
}

export async function verifiedCall(hash, accountId) {
  if (!/^[A-Za-z0-9]+$/.test(String(hash || ""))) throw new Error("Missing transaction");
  return fetchTx(hash, accountId);
}

export async function takeDeposit(user, txHash) {
  requireAccount(user);
  const call = await verifiedCall(txHash, user.accountId);
  if (call.method !== "deposit") throw new Error("That was not a deposit");
  await syncBalance(user);
  claimNearTx(txHash, user.accountId, "deposit");
}

export async function takeWithdraw(user, txHash) {
  requireAccount(user);
  const call = await verifiedCall(txHash, user.accountId);
  if (call.method !== "withdraw") throw new Error("That was not a refund");
  await syncBalance(user);
  claimNearTx(txHash, user.accountId, "withdraw");
}

async function claimLock(accountId, micro) {
  const key = releaseKey();
  if (!key) throw new Error("Refunds are not ready on this server yet");
  await signAndSend({
    accountId: contractId(),
    secretKey: key,
    methodName: "claim",
    args: { account: accountId, amount: String(micro) },
  });
}

async function releaseLock(accountId, micro) {
  const key = releaseKey();
  if (!key) return;
  await signAndSend({
    accountId: contractId(),
    secretKey: key,
    methodName: "release",
    args: { account: accountId, amount: String(micro) },
  });
}

export async function takeLockedBet(book, user, body) {
  requireAccount(user);
  const usd = Math.round(Number(body.amount) * 100) / 100;
  if (!(usd > 0)) throw new Error("Amount must be positive");
  const micro = usdToMicro(usd).toString();
  const call = await verifiedCall(body.txHash, user.accountId);
  if (call.method !== "lock") throw new Error("Sign a lock for this bet");
  if (String(call.args.amount) !== micro) throw new Error("Locked amount does not match the bet");
  claimNearTx(body.txHash, user.accountId, "lock");
  try {
    await claimLock(user.accountId, micro);
    await syncBalance(user);
    return withLedger(book, user, () => {
      if (body.stake) {
        stake(book, {
          marketId: body.marketId,
          agentId: body.agentId,
          amount: usd,
          near: true,
          prepaid: true,
          now: Date.now(),
        });
        return {};
      }
      const fill = bet(book, {
        marketId: body.marketId,
        side: body.side,
        amount: usd,
        via: body.via || "me",
        near: true,
        prepaid: true,
        now: Date.now(),
      });
      return { fill };
    });
  } catch (err) {
    try {
      await releaseLock(user.accountId, micro);
      await syncBalance(user);
    } catch (releaseErr) {
      console.error("release skipped:", releaseErr.message);
    }
    throw err;
  }
}

export async function confirmAgentKey(user, agent) {
  requireAccount(user);
  const row = agentKey(agent.id);
  if (!row) throw new Error("Host the agent again");
  const access = await viewAccessKey(user.accountId, row.public_key);
  const permission = access.permission?.FunctionCall || access.permission?.function_call;
  if (!permission) throw new Error("Approve the agent key in your wallet");
  const receiver = permission.receiver_id || permission.receiverId;
  if (receiver !== contractId()) throw new Error("The agent key points at the wrong contract");
  agent.live = true;
  agent.publicKey = row.public_key;
  return agent;
}

export async function settleNear(book) {
  const key = releaseKey();
  const markets = book.markets.filter((m) => m.nearOps?.length && !m.nearSettled);
  if (!markets.length) return [];
  if (!key) {
    console.error("NEAR settlement is waiting for the release key");
    return [];
  }
  const accounts = [];
  for (const market of markets) {
    for (const op of market.nearOps) {
      if (!op.slash) continue;
      try {
        await signAndSend({
          accountId: contractId(),
          secretKey: key,
          methodName: "slash",
          args: { account: op.accountId, amount: String(op.slash) },
        });
      } catch (err) {
        if (!/Not enough locked/i.test(err.message)) throw err;
      }
    }
    for (const op of market.nearOps) {
      if (!op.release && !op.extra) continue;
      try {
        await signAndSend({
          accountId: contractId(),
          secretKey: key,
          methodName: "payout",
          args: {
            account: op.accountId,
            release_amount: String(op.release || 0),
            extra: String(op.extra || 0),
          },
        });
      } catch (err) {
        if (!/Not enough locked|Not enough pot/i.test(err.message)) throw err;
      }
    }
    market.nearSettled = true;
    for (const op of market.nearOps) {
      if (op.accountId && !accounts.includes(op.accountId)) accounts.push(op.accountId);
    }
  }
  return accounts;
}

export function usdFromChainMicro(micro) {
  return usdFromMicro(micro);
}
