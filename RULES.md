# Pencils coordination rules

Pencils is a swarm of agents around one order book. Humans can bet too. A thesis is a sentence that can resolve Yes or No. The price is the swarm's current belief. The encyclopedia line is rewritten from that price.

These rules are what `server/swarm.mjs` runs every few seconds, and what `contract/src/lib.rs` enforces for trades, stakes, and resolution. The JavaScript engine is the live demo. The contract is the same integer math, ready for testnet, and it is not deployed by `npm start`.

## Who holds the money

- The demo account starts with $250. That balance is only spent by you, and by user agents you allow to trade.
- Pulse, Ledger, and Contra each have a $2,000 bankroll. Quorum has $500. Swarm trades debit those banks. They never touch the $250.
- A user agent has a spending limit (default $50, slider up to $500). Turning on trade lets it buy inside that limit, and each buy also debits your balance.
- A coalition stake of $10, $25, or $50 debits your balance and does not count against the agent's trade limit. On the contract, `stake` is the same: it skips the policy limit. `buy` does not.

## One round

```
Pulse, Ledger, Contra          Quorum                 You
        |                         |                    |
        | trade $4-$9 on a live   |                    |
        | market, own bankroll    |                    |
        |-----------------------> book                |
        |                         |                    |
        | Ledger may stake $10    |                    |
        | into a coalition (Yes)  |                    |
        |                         |                    |
        | Contra may open a       |                    |
        | counter-market if the   |                    |
        | price is one-sided      |                    |
        |                         |                    |
        | Pulse may publish one   |                    |
        | queued thesis           |                    |
        |                         |                    |
        |                         | check sources      |
        |                         |                    |
        |                         |                    | bet, stake,
        |                         |                    | or publish
        |                         |                    |
   after the deadline             |                    |
        |                         | propose Yes or No  |
        |                         | (24h window)       |
        |                         |                    | override once
        |                         | finalize           |
        |                         | pay $1 / share     |
```

Each round does at most one of each optional action. Nothing here calls a model. `npm run simulate` replays 24 rounds from a fixed seed, then forces one market through deadline, proposal, and finalization.

## How an agent picks a side

All three system agents look at the same spot price, `no_reserve / (yes_reserve + no_reserve)`.

- Pulse follows momentum. Above 52% it buys Yes. Below 48% it buys No. In between it takes the side the price already leans to.
- Ledger is a value buyer. Under 40% it buys Yes. Over 70% it buys No. Between those it buys the leading side.
- Contra fades the leader. It buys No when Yes is at or above 50%, and Yes otherwise.
- About 18% of rounds, Ledger stakes $10 on a market priced between 35% and 72% that it has not already joined.
- About 12% of rounds, if some market is at or above 70% or at or below 30% and has no counter yet, Contra opens one. The counter starts near `1 - p` and resolves Yes when the original resolves No.
- About 8% of rounds, Pulse publishes the next built-in draft thesis. Drafts already pass the resolvability check.
- A separate loop reads X, Reddit, and BBC technology news. With a NEAR AI key, one hosted agent whose watch list matches the post publishes a thesis from it. If none matches, Pulse publishes it. That loop is capped at 4 drafts per UTC day and 30 minutes between drafts.
- A user agent with trade permission buys on about 45% of rounds, $2 to $6, on the leading side, until its limit or your balance runs out. If it has a watch list, it prefers a market whose title contains one of those words.

## Publishing a thesis

A person cannot publish a thesis or open a market. Hosted agents and the system swarm can. The person can still buy Yes or No, stake through an agent, and override a resolution.

Quorum accepts a sentence when at least 3 of these 4 are true:

1. It contains a number, a percent, or a dollar amount.
2. It contains a deadline (a date, "before", "within", "this week", and similar).
3. It names something checkable (a price, a chart, a launch, a report, transactions, and similar).
4. It is one sentence between 30 and 180 characters.

A new market opens at 50% with $800 of virtual liquidity on each side. The highlighted number in the title is the claim.

## The book

Amounts are integer micro-USDC (6 decimals). The fee is 50 bps, taken out of the budget before it hits the pool.

A Yes buy adds the net budget to the No reserve, then removes Yes reserve so the product `yes * no` stays constant (integer division). Shares issued are `net + reserve_sold`. A No buy is the mirror. After every fill:

- `yes_reserve + yes_liabilities = collateral`
- `no_reserve + no_liabilities = collateral`

The spot Yes price is `no / (yes + no)`, clamped in the engine to 2% through 98% when a pool is seeded. A $10 Yes buy on a fresh 50/50 pool is the shared fixture: fee 50,000, net 9,950,000, Yes reserve 790,172,232, No reserve 809,950,000, shares 19,777,768. `npm test` and `cargo test` both assert those numbers.

Seed markets are walked to their design price by a virtual house trade before the server starts. The volume, trader count, and coalition dollars shown on those opening cards are the design narrative. They are not AMM shares. `coalitionShares` starts empty, so only stakes placed after boot earn the fee pot. Trades after boot are real pool fills. The chart history before boot is a cosmetic path that ends at the spot price. Points after boot are fills.

## Resolution

- Only Quorum proposes, and only after `ends`.
- In the demo, the outcome is a hash of the market id (FNV-style). It does not read the price, so agents cannot vote the oracle by trading.
- Status becomes `proposed`. For 24 hours the owner (you, in the demo) can override Yes or No.
- After 24 hours anyone can finalize. Each winning share pays $1 into the holder's balance. Losing shares pay $0.
- If the outcome is Yes, the fee pot is split pro-rata by coalition dollars staked after boot. A No outcome keeps the pot. The contract records fees on the market and pays winning shares through `redeem`. The pro-rata fee split runs in the JavaScript engine.

## Sub-accounts

Connecting an agent records a policy, not a signed transaction:

- Handle `agent-N.pencilsbuzz.testnet` in the product. The contract account named in the policy is `pencilsbuzz.testnet` when `PENCILS_CONTRACT` is set.
- Methods: `buy`, `stake`, `create_market`.
- Function-call allowance recorded as 5 NEAR.
- `can_propose` starts on. `can_trade` starts off. You flip both from the agent card, and you set the limit.

Deploying `contract/` and creating real NEAR sub-accounts is a separate step. The server does not sign, and it does not spend NEAR, unless you add a key and a deploy yourself. `.env.example` leaves the private key commented out.

## Intents and the encyclopedia

- Deposit and withdraw ask NEAR Intents 1Click for a USDC quote with `dry: true`. A dry quote returns a route and does not create a deposit address. The demo balance still updates locally so the portfolio can be tried without mainnet funds. Intents has no testnet. Quotes are mainnet routes that move nothing.
- If `NEAR_AI_API_KEY` is set, a price move of 3 points or more can ask NEAR AI Cloud for a one-sentence page. The budget is 6 calls per UTC day and one call per market every 6 hours. Any failure keeps the existing sentence. With no key, the swarm still runs and the pages stay on their templates.
