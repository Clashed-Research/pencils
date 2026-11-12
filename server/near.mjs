import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";

export const YOCTO_PER_MICRO = 10n ** 18n;
export const MICRO_PER_NEAR = 1_000_000n;

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function contractId() {
  return process.env.PENCILS_CONTRACT || "pencilsbuzz.testnet";
}

export function rpcUrl() {
  return process.env.NEAR_RPC || "https://rpc.testnet.fastnear.com";
}

export function base58Encode(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  let num = 0n;
  for (const byte of bytes) num = (num << 8n) + BigInt(byte);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  return "1".repeat(zeros) + out;
}

export function base58Decode(text) {
  let num = 0n;
  for (const char of String(text)) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error("Invalid base58");
    num = num * 58n + BigInt(index);
  }
  const out = [];
  while (num > 0n) {
    out.push(Number(num & 0xffn));
    num >>= 8n;
  }
  out.reverse();
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  return Buffer.from([...Array(zeros).fill(0), ...out]);
}

export function yoctoFromNear(amount) {
  const text = String(amount).trim();
  if (!/^\d+(\.\d{1,24})?$/.test(text)) throw new Error("Enter a NEAR amount");
  const [whole, frac = ""] = text.split(".");
  const padded = (frac + "0".repeat(24)).slice(0, 24);
  return BigInt(whole) * 10n ** 24n + BigInt(padded);
}

export function microFromYocto(yocto) {
  return BigInt(yocto) / YOCTO_PER_MICRO;
}

export function yoctoFromMicro(micro) {
  return BigInt(micro) * YOCTO_PER_MICRO;
}

export function usdFromMicro(micro) {
  return Number(micro) / 1e6;
}

export function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const seed = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32);
  const secret = Buffer.concat([seed, pub]);
  return {
    publicKey: `ed25519:${base58Encode(pub)}`,
    secretKey: `ed25519:${base58Encode(secret)}`,
  };
}

function rawKey(value) {
  const text = String(value || "");
  const body = text.startsWith("ed25519:") ? text.slice(8) : text;
  const raw = base58Decode(body);
  if (raw.length === 64) return { seed: raw.subarray(0, 32), pub: raw.subarray(32) };
  if (raw.length === 32) return { seed: raw, pub: null };
  throw new Error("NEAR key has the wrong length");
}

function signingKey(secret) {
  const { seed } = rawKey(secret);
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
}

function u32(n) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n);
  return buf;
}

function u64(n) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(n));
  return buf;
}

function u128(n) {
  const buf = Buffer.alloc(16);
  let x = BigInt(n);
  for (let i = 0; i < 16; i++) {
    buf[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return buf;
}

function str(value) {
  const body = Buffer.from(String(value));
  return Buffer.concat([u32(body.length), body]);
}

function bytes(value) {
  const body = Buffer.from(value);
  return Buffer.concat([u32(body.length), body]);
}

export function functionCallTx({ signerId, publicKey, nonce, receiverId, blockHash, methodName, args, gas, deposit }) {
  const pub = base58Decode(String(publicKey).replace(/^ed25519:/, ""));
  if (pub.length !== 32) throw new Error("Public key must be 32 bytes");
  const hash = base58Decode(blockHash);
  if (hash.length !== 32) throw new Error("Block hash must be 32 bytes");
  const argBytes = Buffer.from(typeof args === "string" ? args : JSON.stringify(args));
  return Buffer.concat([
    str(signerId),
    Buffer.from([0]),
    pub,
    u64(nonce),
    str(receiverId),
    hash,
    u32(1),
    Buffer.from([2]),
    str(methodName),
    bytes(argBytes),
    u64(gas),
    u128(deposit),
  ]);
}

export function signSerialized(txBytes, secretKey) {
  const hash = createHash("sha256").update(txBytes).digest();
  const sig = sign(null, hash, signingKey(secretKey));
  if (sig.length !== 64) throw new Error("Unexpected signature length");
  return Buffer.concat([txBytes, Buffer.from([0]), sig]);
}

async function rpc(method, params) {
  const res = await fetch(rpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "pencils", method, params }),
  });
  const json = await res.json();
  if (json.error) {
    const message = json.error.data || json.error.message || "NEAR RPC failed";
    throw new Error(typeof message === "string" ? message : JSON.stringify(message));
  }
  return json.result;
}

export async function viewFunds(accountId) {
  const result = await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contractId(),
    method_name: "get_funds",
    args_base64: Buffer.from(JSON.stringify({ account: accountId })).toString("base64"),
  });
  const text = Buffer.from(result.result).toString("utf8");
  return JSON.parse(text);
}

export async function viewAccessKey(accountId, publicKey) {
  return rpc("query", {
    request_type: "view_access_key",
    finality: "final",
    account_id: accountId,
    public_key: publicKey,
  });
}

function txSucceeded(status) {
  if (!status || status.Failure || status.failure) return false;
  return Object.prototype.hasOwnProperty.call(status, "SuccessValue") || status.SuccessReceiptId;
}

export function readFunctionCall(tx) {
  const transaction = tx.transaction || tx;
  const actions = transaction.actions || [];
  const call = actions
    .map((action) => action.FunctionCall || action.function_call || (action.type === "FunctionCall" ? action.params : null))
    .find(Boolean);
  if (!call) throw new Error("Transaction did not call the contract");
  const method = call.method_name || call.methodName;
  const rawArgs = call.args || "";
  let args = {};
  if (rawArgs) {
    const decoded = Buffer.from(rawArgs, "base64").toString("utf8");
    args = decoded ? JSON.parse(decoded) : {};
  }
  return {
    signerId: transaction.signer_id || transaction.signerId,
    receiverId: transaction.receiver_id || transaction.receiverId,
    method,
    args,
    deposit: String(call.deposit || "0"),
  };
}

export async function fetchTx(hash, accountId) {
  const tx = await rpc("tx", { tx_hash: hash, sender_account_id: accountId, wait_until: "EXECUTED" });
  if (!txSucceeded(tx.status)) throw new Error("Transaction failed");
  const call = readFunctionCall(tx);
  if (call.receiverId !== contractId()) throw new Error("Transaction went to the wrong contract");
  if (call.signerId !== accountId) throw new Error("Transaction was signed by a different account");
  return call;
}

let signQueue = Promise.resolve();

function queued(fn) {
  const run = signQueue.then(fn, fn);
  signQueue = run.then(
    () => {},
    () => {},
  );
  return run;
}

export async function signAndSend({ accountId, secretKey, methodName, args = {}, deposit = "0", gas = "30000000000000" }) {
  return queued(async () => {
    const publicKey = `ed25519:${base58Encode(rawKey(secretKey).pub)}`;
    const access = await viewAccessKey(accountId, publicKey);
    const tx = functionCallTx({
      signerId: accountId,
      publicKey,
      nonce: Number(access.nonce) + 1,
      receiverId: contractId(),
      blockHash: access.block_hash,
      methodName,
      args,
      gas,
      deposit,
    });
    const signed = signSerialized(tx, secretKey);
    const result = await rpc("broadcast_tx_commit", [signed.toString("base64")]);
    if (!txSucceeded(result.status)) throw new Error("Transaction failed");
    return result.transaction?.hash || result.transaction_outcome?.id || "";
  });
}
