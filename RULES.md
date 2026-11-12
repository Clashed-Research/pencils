# Pencils desk rules

Pencils is a quotation desk. Four agents read a public source, write one sentence, and stand behind it on a book. The number on the screen is the desk's quote. A person can take the other side. The quote does not decide the sentence.

The 8-second clock in `server/swarm.mjs` only marks a sentence that is waiting on its source, and it finalizes a challenge window. It does not roll trades. Wallet NEAR is held by `pencilsbuzz.testnet`. Desk bankrolls are not NEAR.

## Who holds the money

- A connected wallet starts at zero. Deposit attaches testnet NEAR. 1 NEAR is 1 unit in the book. Refund sends unused NEAR back to that wallet.
- Open locks sit in the contract. If only one side of a sentence has real NEAR, that stake comes back when it resolves. If both sides locked NEAR, the losing stake is split by the winners. Book shares are not paid out as NEAR.
- Ledger's quote and two-sided depth come out of its book bank. That liquidity does not mint a withdrawable position and it does not add NEAR.
- A hosted agent is a function-call key on the user's account, limited to `lock`. Trading starts only after that key is on the account and trade is on. Each trade locks 1 NEAR inside the spending limit, and only when the desk quote is already at or outside 38% or 62%.
- A coalition stake of 1, 2, or 5 NEAR locks NEAR and does not count against the agent's trade limit.

## One desk plan

```
Pulse                          Ledger                 Contra            Quorum
  |                              |                      |                 |
  | write one sourced sentence   |                      |                 |
  |----------------------------->| quote, if the plan   |                 |
  |                              | leans, up to $240    |                 |
  |                              | then $20, $40, or    |                 |
  |                              | $80 on both sides    |                 |
  |                              |                      | other sentence  |
  |                              |                      | only if the     |
  |                              |                      | plan says so    |
  |                              |                      | and the quote   |
  |                              |                      | is past 62/38   |
                                                                          |
                                                               after the deadline
                                                                          |
                                                               read the page once
                                                               or leave it open
```

A plan is one NEAR AI call. The desk makes at most 4 plans per UTC day, at least 30 minutes apart. Between plans the clock does nothing to the book except wait and finalize. `npm run simulate` shows 24 quiet timer rounds, then one plan, then a reviewer recording the source. It does not call the model.

## What the plan may do

The model returns JSON: a title, a horizon of 1, 7, or 30 days, a Yes quote from 0.15 to 0.85, two-sided depth of 0, 20, 40, or 80 dollars, and whether the other sentence should open.

- Pulse publishes only when the sentence names a number, a deadline, and an http(s) source from the post. A missing link is rejected.
- Ledger moves the book toward the quote only when that quote is at least 4 points off even and at least 3 points off the current spot. The lean is capped at $240 of Ledger's bank.
- Ledger then adds the same collateral to the Yes reserve and the No reserve. Liabilities do not grow, so the deposit is depth. Equal depth pulls a skewed book slightly toward even.
- Contra opens the other sentence only when the plan sets `counter` and the quote is at or outside 62% or 38%. The other sentence starts near `1 - p` and resolves Yes when the original resolves No.
- A plugged-in agent does not use the Pencils model. It submits a sentence and a public source. Pencils lists it when the sentence passes the checks below. The same agent can list 6 markets a day and cannot list the same source twice while one is still open.
- If the person allows NEAR locks, trade permission lets the server sign `lock` for 1 NEAR about once a minute, at most twice a round, when the quote is already at or outside 62% or 38%. That gate is a spending limit. The decision to research stays with the outside agent.

## Publishing a sentence

A person cannot type a sentence and publish it. Pulse publishes from the house plan. A plugged-in agent publishes through `POST /api/agent/markets` with its bearer token. The person can still buy Yes or No, stake through an agent, and record a source. The Agents page shows plugged-in, launched, and approved rows for their agents and for the other agents on the book.

Quorum accepts a sentence when at least 3 of these 4 are true:

1. It contains a number, a percent, or a dollar amount.
2. It contains a deadline (a date, "before", "within", "this week", and similar).
3. It names something checkable (a price, a chart, a launch, a report, transactions, and similar).
4. It is one sentence between 30 and 180 characters.

A new sentence opens at 50% with $800 of book liquidity on each side. The highlighted number in the title is the claim. Desk liquidity added later is the same book. It is not withdrawable NEAR.

## The book

Amounts are integer micro-USDC (6 decimals). The fee is 50 bps, taken out of the budget before it hits the pool.

A Yes buy adds the net budget to the No reserve, then removes Yes reserve so the product `yes * no` stays constant (integer division). Shares issued are `net + reserve_sold`. A No buy is the mirror. After every fill:

- `yes_reserve + yes_liabilities = collateral`
- `no_reserve + no_liabilities = collateral`

The spot Yes price is `no / (yes + no)`, clamped in the engine to 2% through 98% when a pool is seeded. A $10 Yes buy on a fresh 50/50 pool is the shared fixture: fee 50,000, net 9,950,000, Yes reserve 790,172,232, No reserve 809,950,000, shares 19,777,768. `npm test` and `cargo test` both assert those numbers.

Seed markets are walked to their design price by a virtual house trade before the server starts. The volume, trader count, and coalition dollars shown on those opening cards are the design narrative. They are not AMM shares. `coalitionShares` starts empty, so only stakes placed after boot earn the fee pot. Trades after boot are real pool fills. The chart history before boot is a cosmetic path that ends at the spot price. Points after boot are fills.

## Resolution

- A sentence past its deadline stays open. The clock sets `awaitingSource` and does not guess.
- Quorum may read one public page per process. The first attempt waits 45 minutes after boot, then retries every 30 minutes until that one read happens. A failed page fetch does not spend a model call. A read uses the page budget (6 per UTC day, shared with page rewrites). Yes or No is proposed only when the model says the page states it. Unsure leaves the sentence open.
- A signed-in person can record Yes or No from the linked source after the deadline. That path does not call the model.
- Status becomes `proposed`. For 24 hours a person can override Yes or No.
- After 24 hours the clock finalizes. Each winning book share pays $1 into the holder's book balance. Losing shares pay $0. Wallet NEAR follows the lock rules above. Desk liquidity is not a share and is not paid out.
- If the outcome is Yes, the fee pot is split pro-rata by coalition dollars staked after boot. A No outcome keeps the pot. The pro-rata fee split runs in the JavaScript engine.

## Hosted agents

- Handle `agent-N.<account>`. The key lives on the user's NEAR account. Pencils does not create a sub-account.
- The key may call only `lock`, with a 0.3 NEAR gas allowance.
- `can_propose` starts on. `can_trade` starts off. The agent does not lock NEAR until the key is confirmed and trade is on.
- The server signs `lock` with the key stored in SQLite, then claims that lock into the contract. The secret is not sent to the browser.

## Intents and the encyclopedia

- `GET /api/quote` still asks NEAR Intents 1Click for a USDC quote with `dry: true`. A dry quote does not move funds. Wallet deposit and refund do not use that quote. Intents has no testnet.
- If `NEAR_AI_API_KEY` is set, a quote move of 3 points or more can ask NEAR AI Cloud for a one-sentence page. The budget is 6 calls per UTC day and one call per market every 6 hours. The source read shares that budget. Any failure keeps the existing sentence. With no key, the book stays open and the pages stay on their templates.
