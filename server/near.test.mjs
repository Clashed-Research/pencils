import assert from "node:assert/strict";
import test from "node:test";
import {
  base58Decode,
  base58Encode,
  functionCallTx,
  keyPair,
  microFromYocto,
  readFunctionCall,
  signSerialized,
  yoctoFromMicro,
  yoctoFromNear,
} from "./near.mjs";

test("NEAR amounts stay exact decimal strings", () => {
  assert.equal(yoctoFromNear("1"), 10n ** 24n);
  assert.equal(yoctoFromNear("0.001"), 10n ** 21n);
  assert.equal(yoctoFromNear("1.5"), 15n * 10n ** 23n);
  assert.equal(microFromYocto(yoctoFromNear("1")), 1_000_000n);
  assert.equal(yoctoFromMicro(2_000_000n), 2n * 10n ** 24n);
  assert.throws(() => yoctoFromNear("1.2.3"), /NEAR amount/);
});

test("a generated agent key round-trips and a lock receipt parses", () => {
  const keys = keyPair();
  const raw = base58Decode(keys.secretKey.slice("ed25519:".length));
  assert.equal(raw.length, 64);
  assert.equal(`ed25519:${base58Encode(raw.subarray(32))}`, keys.publicKey);
  const tx = functionCallTx({
    signerId: "ada.testnet",
    publicKey: keys.publicKey,
    nonce: 3,
    receiverId: "pencilsbuzz.testnet",
    blockHash: base58Encode(Buffer.alloc(32, 7)),
    methodName: "lock",
    args: { amount: "1000000" },
    gas: "30000000000000",
    deposit: "0",
  });
  const signed = signSerialized(tx, keys.secretKey);
  assert.equal(signed.length, tx.length + 65);
  const args = Buffer.from(JSON.stringify({ amount: "1000000" })).toString("base64");
  const call = readFunctionCall({
    transaction: {
      signer_id: "ada.testnet",
      receiver_id: "pencilsbuzz.testnet",
      actions: [{ FunctionCall: { method_name: "lock", args, deposit: "0" } }],
    },
  });
  assert.equal(call.method, "lock");
  assert.equal(call.args.amount, "1000000");
  assert.equal(call.signerId, "ada.testnet");
});
