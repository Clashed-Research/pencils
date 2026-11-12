const GAS = 30_000_000_000_000n;
const SDK = "https://esm.sh/@meteorwallet/sdk@3.24.1";
const TX = "https://esm.sh/@near-js/transactions@2.2.5";
const CRYPTO = "https://esm.sh/@near-js/crypto@2.2.5";
const TARGET = { blockchain: "near", network: "testnet" };

let meteor = null;
let contract = "pencilsbuzz.testnet";
let creators = null;
let PublicKey = null;
let opening = null;

export function yoctoFromNear(amount) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(text)) throw new Error("Enter a NEAR amount");
  const [whole, frac = ""] = text.split(".");
  const padded = (frac + "0".repeat(24)).slice(0, 24);
  return BigInt(whole) * 10n ** 24n + BigInt(padded);
}

export function nearText(amount) {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!(value > 0)) throw new Error("Amount must be positive");
  return value.toFixed(2);
}

function explain(err) {
  const reason = err && err._reason;
  const tags = Array.isArray(reason?.endTags) ? reason.endTags.join(" ") : "";
  const message = (err && err.message) || reason?.message || "Meteor could not connect";
  if (/cancel/i.test(message) || /USER_CANCELLED|WINDOW_CLOSED/.test(tags)) {
    return new Error("Meteor closed before it finished. Leave its window open, choose the extension, and approve the testnet account. Allow popups for pencils.buzz if the browser blocked it.");
  }
  if (/NO_ACCOUNTS/.test(tags) || /no current account/i.test(message)) {
    return new Error("Meteor has no account on testnet. In Meteor, switch to testnet and pick an account.");
  }
  if (/POPUP_WINDOW/.test(tags) || /popup/i.test(message)) {
    return new Error("The browser blocked the Meteor window. Allow popups for pencils.buzz, then click Meteor again.");
  }
  return err instanceof Error ? err : new Error(message);
}

async function start() {
  const [sdk, tx, crypto] = await Promise.all([import(SDK), import(TX), import(CRYPTO)]);
  creators = tx.actionCreators;
  PublicKey = crypto.PublicKey;
  const client = new sdk.MeteorConnect();
  await client.initialize({
    storage: sdk.webpage_local_storage,
    mobileBridge: {
      enabled: true,
      partnerMetadata: {
        name: "Pencils",
        description: "Testnet markets. Deposit, refund, and lock NEAR on pencilsbuzz.testnet.",
        iconUrl: `${location.origin}/favicon.ico`,
        originUrl: location.origin,
      },
    },
  });
  meteor = client;
  return client;
}

async function open() {
  if (meteor && creators && PublicKey) return meteor;
  if (!opening) opening = start();
  try {
    return await opening;
  } catch (err) {
    opening = null;
    meteor = null;
    throw explain(err);
  }
}

export async function initWallet(contractId) {
  if (contractId) contract = contractId;
  await open();
}

export async function connectedAccount() {
  try {
    const row = await (await open()).getAccount(TARGET);
    return row?.identifier?.accountId || "";
  } catch {
    return "";
  }
}

function meteorCancel(action) {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", "Close");
  button.textContent = "×";
  button.style.cssText = "position:fixed;top:16px;right:16px;z-index:2147483646;width:40px;height:40px;border:0;border-radius:999px;background:#fff;color:#111;font:600 24px/36px system-ui;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.25)";
  button.addEventListener("click", () => {
    button.disabled = true;
    Promise.resolve(typeof action.cancelAction === "function" ? action.cancelAction() : null).catch(() => {});
  });
  document.body.appendChild(button);
  return () => button.remove();
}

async function prompt(id, input) {
  const client = await open();
  const action = await client.createAction({ id, input });
  const close = meteorCancel(action);
  try {
    return await action.promptForExecution();
  } catch (err) {
    throw explain(err);
  } finally {
    close();
  }
}

async function ensureAccount() {
  const client = await open();
  let row = await client.getAccount(TARGET);
  if (!row?.identifier?.accountId) row = await prompt("near::sign_in", { target: TARGET });
  const accountId = row?.identifier?.accountId || "";
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId)) {
    throw new Error("Meteor did not return a testnet account. Switch Meteor to testnet and pick an account.");
  }
  return row;
}

function failureText(status) {
  const failure = status?.Failure || status?.failure;
  if (!failure) return "";
  if (typeof failure === "string") return failure;
  const exec = failure.ActionError?.kind?.FunctionCallError?.ExecutionError;
  return typeof exec === "string" ? exec : "The transaction failed";
}

function hashOf(outcome) {
  const rows = Array.isArray(outcome) ? outcome : [outcome];
  const row = rows.find((item) => item && (item.transaction || item.transaction_outcome));
  if (!row) throw new Error("Meteor did not return a transaction");
  const failed = failureText(row.status);
  if (failed) throw new Error(failed);
  const hash = row.transaction?.hash || row.transaction_outcome?.id || "";
  if (!hash) throw new Error("Meteor did not return a transaction");
  return hash;
}

async function send(walletId, actions) {
  if (walletId === "my-near-wallet") throw new Error("MyNearWallet can no longer connect. Use Meteor.");
  const client = await open();
  const row = await client.getAccount(TARGET);
  const accountId = row?.identifier?.accountId || "";
  if (!/^[a-z0-9._-]{2,64}$/.test(accountId)) {
    throw new Error("Connect Meteor first. The next click signs the transaction.");
  }
  const outcome = await prompt("near::sign_transactions", {
    target: row.identifier,
    transactions: [{ receiverId: contract, actions }],
  });
  return { accountId, txHash: hashOf(outcome) };
}

function call(methodName, args, deposit) {
  return creators.functionCall(methodName, args, GAS, deposit);
}

export async function register(walletId) {
  if (walletId === "my-near-wallet") throw new Error("MyNearWallet can no longer connect. Use Meteor.");
  const client = await open();
  const existing = await client.getAccount(TARGET);
  if (!existing?.identifier?.accountId) {
    const row = await ensureAccount();
    return { accountId: row.identifier.accountId, needsSign: true };
  }
  return send(walletId, [call("register", {}, 0n)]);
}

export async function deposit(walletId, amount) {
  await open();
  return send(walletId, [call("deposit", {}, yoctoFromNear(nearText(amount)))]);
}

export async function withdraw(walletId, amount) {
  await open();
  const text = nearText(amount);
  const micro = (yoctoFromNear(text) / 10n ** 18n).toString();
  return send(walletId, [call("withdraw", { amount: micro }, 0n)]);
}

export async function lock(walletId, amount) {
  await open();
  const text = nearText(amount);
  const micro = (yoctoFromNear(text) / 10n ** 18n).toString();
  return send(walletId, [call("lock", { amount: micro }, 0n)]);
}

export async function addAgentKey(walletId, publicKey) {
  await open();
  const key = PublicKey.from(String(publicKey || ""));
  const accessKey = creators.functionCallAccessKey(contract, ["lock"], yoctoFromNear("0.3"));
  return send(walletId, [creators.addKey(key, accessKey)]);
}
