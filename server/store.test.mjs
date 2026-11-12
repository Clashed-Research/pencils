import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bet, withLedger } from "../engine/book.mjs";
import { agentByPlugToken, blankUser, closeStore, insertUser, loadBook, openStore, reserveAiCall, saveBook, saveUser, startAgentToken, startSession, userByToken } from "./store.mjs";

test("sqlite keeps the shared book and separate account balances", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pencils-"));
  const file = path.join(dir, "pencils.sqlite");
  openStore(file);
  const book = loadBook();
  const before = book.markets.find((m) => m.id === "btc-150").p;
  const ada = blankUser(1_700_000_000_000);
  const bo = blankUser(1_700_000_000_000);
  ada.balance = 250;
  bo.balance = 250;
  insertUser(ada, "10.0.0.1");
  insertUser(bo, "10.0.0.2");
  const now = Date.now();
  withLedger(book, ada, () => bet(book, { marketId: "btc-150", side: "yes", amount: 10, now }));
  withLedger(book, bo, () => bet(book, { marketId: "btc-150", side: "no", amount: 10, now }));
  assert.equal(ada.balance, 240);
  assert.equal(bo.balance, 240);
  assert.equal(ada.positions.length, 1);
  assert.equal(bo.positions.length, 1);
  assert.notEqual(ada.positions[0].side, bo.positions[0].side);
  saveUser(ada);
  saveUser(bo);
  saveBook(book);
  const price = book.markets.find((m) => m.id === "btc-150").p;
  assert.notEqual(price, before);

  closeStore();
  openStore(file);
  const again = loadBook();
  const savedAda = userByToken(startSession(ada.id));
  assert.equal(again.markets.find((m) => m.id === "btc-150").p, price);
  assert.equal(savedAda.balance, 240);
  ada.agents = [{ id: "ua1", name: "Scout", perms: { propose: true } }];
  saveUser(ada);
  const plug = startAgentToken("ua1", ada.id);
  assert.equal(agentByPlugToken(plug).agent.name, "Scout");
  assert.equal(agentByPlugToken("pk_" + "ab".repeat(24)), null);
  const next = startAgentToken("ua1", ada.id);
  assert.equal(agentByPlugToken(plug), null);
  assert.equal(agentByPlugToken(next).agent.id, "ua1");
  assert.equal(savedAda.positions[0].side, "yes");
  assert.equal(again.balance, 0);
});

test("NEAR AI budget is six calls a day and one call per market each six hours", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pencils-ai-"));
  openStore(path.join(dir, "pencils.sqlite"));
  const start = Date.parse("2026-11-11T00:00:00Z");
  assert.equal(reserveAiCall("btc", start).ok, true);
  const soon = reserveAiCall("btc", start + 60 * 60 * 1000);
  assert.equal(soon.ok, false);
  assert.equal(soon.reason, "cooldown");
  for (let i = 1; i < 6; i += 1) {
    const slot = reserveAiCall("m" + i, start + i);
    assert.equal(slot.ok, true);
  }
  assert.equal(reserveAiCall("m6", start + 6).reason, "daily");
  closeStore();
  openStore(path.join(dir, "pencils.sqlite"));
  const nextDay = reserveAiCall("btc", start + 24 * 60 * 60 * 1000);
  assert.equal(nextDay.ok, true);
  assert.equal(nextDay.used, 1);
  closeStore();
});
