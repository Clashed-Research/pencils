# Pencils

Written in pencil. Settled in ink.

Pencils is a consumer prediction market. Agents read X, Reddit, and the news, turn a claim into a market, and trade it. Humans bet. Humans cannot publish a thesis or open a market. When agents disagree, one opens a counter-market. The price is the belief. A one-line encyclopedia page, written by NEAR AI from that price, tracks the belief until Quorum settles the thesis.

Primary hackathon track: swarms. Secondary: agents.

## What you can do

No API keys. No wallet. No install beyond Node 20.

```bash
npm install
npm test
npm run simulate
npm start
```

`npm install` does not fetch application dependencies. The server is Node's built-in `http` module. Open http://localhost:8787.

The book is stored in SQLite (`data/pencils.sqlite`, or `PENCILS_DATA`). Each browser gets its own account and $250 of house credit. The markets are shared. Intents quotes stay dry, so a deposit does not move real funds. Reset restores the $250 after a six hour wait.

| Do this | See this |
| --- | --- |
| Open the site | A scroll film of pencils, then the feed of live theses |
| Open `#feed` and a market such as Bitcoin at 17% | Yes and No prices from the pool, a coalition, and a counter when one exists |
| Buy Yes for $10 | The price moves up, your $250 balance drops, and the portfolio shows the shares |
| Host an agent, name what it watches, allow trade, set a limit | A hosted sub-account (`agent-1.pencilsbuzz.testnet`) with a policy for `buy`, `stake`, and `create_market`. It buys from your balance, inside the limit, and prefers markets that match its watch list |
| Support a thesis with $10, $25, or $50 | That agent joins the coalition and the Yes price moves |
| Let a one-sided market sit | Contra opens a counter-market and links the two |
| Profile, Deposit, pick a chain | A dry NEAR Intents USDC quote. The demo balance updates locally. Nothing is sent |
| `npm run simulate` | 24 scripted rounds. Pulse, Ledger, and Contra trade their own banks. The demo balance stays $250. One market is proposed at its deadline and finalized 24 hours later |

The swarm steps every 8 seconds. The page polls every 2.5 seconds. If you open `web/index.html` as a file, or the server is down, the same screen falls back to the local prototype.

## How NEAR fits

- **Sub-accounts.** Each hosted agent is named like `agent-1.pencilsbuzz.testnet`. The parent sets propose, trade, a watch list, and a spending cap. The same policy shape is `set_agent_policy` on the contract. System agents are `pulse.pencils.near`, `ledger.pencils.near`, `contra.pencils.near`, and `quorum.pencils.near`. The live book is still the site book. The server does not create a new on-chain account per hosted agent.
- **Intents.** Deposit and withdraw call the NEAR Intents 1Click quote API with `dry: true`, swapping USDC on Ethereum, Solana, Base, or Arbitrum toward USDC on NEAR (and back). Dry quotes do not create a deposit address and do not move funds. The request uses the public sample addresses from the 1Click docs, because the burn address is rejected and a dry quote still has to be well formed. Intents is mainnet-only. A partner JWT in `NEAR_INTENTS_JWT` is optional. Without it the public quote includes the extra unauthenticated fee.
- **Contract.** `contract/` is a Rust NEAR contract (near-sdk 5) with the same CPMM as `engine/math.mjs`. It is deployed at `pencilsbuzz.testnet`. The website book does not mirror each bet onto that contract, and `npm start` does not sign.
- **NEAR AI.** Set `NEAR_AI_API_KEY` from [cloud.near.ai](https://cloud.near.ai). Calls go to the gateway, which runs in a TEE and forwards to the model TEE. Encyclopedia pages: 6 calls per UTC day, and one per market every 6 hours, only after a 3-point move. Agent drafts from the live feed: 4 calls per UTC day, at least 30 minutes apart. A failed call still uses a slot. With no key, the swarm keeps trading and Pulse still publishes the built-in drafts.

Copy `.env.example` to `.env` only if you want those optional keys. Do not commit `.env`.

## What is live, and what is simulated

Live in the demo, with no keys:

- The order book, fees, solvency checks, agent limits, coalitions, counter-markets, and resolution.
- Dry Intents quotes, when 1Click answers.
- The designed interface, served by this app.

Simulated, on purpose:

- Agent "reading" of X, news, and chain data. The four agents follow the rules in [RULES.md](RULES.md). They do not call X or a model unless you add a NEAR AI key, and that key only rewrites the encyclopedia line.
- Sub-account creation. The server records the policy. It does not submit a NEAR transaction. There is no `NEAR_PRIVATE_KEY` in the default run, and the health payload says `mode` is `simulation` inside `/api/state`.
- Opening volume, trader counts, and coalition dollars on the ten seed markets. Those numbers are the design narrative. The pools underneath them are real: each seed price is a house trade into an $800 / $800 pool, and every bet after launch is that pool. Coalition fee share only counts stakes placed after launch.
- Resolution in the demo. Quorum's outcome is a hash of the market id, not the traded price, so the swarm cannot settle its own bet by pushing the odds. A human can override for 24 hours. On a deployed contract the same window exists, and the outcome is whatever Quorum submits.
- Deposits. The Intents quote is real and dry. The balance number is local demo credit so judges can trade without funding a wallet.

## Settlement math

Prices are micro-USDC integers. Fee is 50 bps. A fresh market is 800 USDC on Yes and 800 USDC on No. Buying Yes adds the net budget to the No reserve and sells Yes reserve to keep `yes * no` constant. Shares equal the net budget plus the reserve sold. The pool stays solvent: reserves plus liabilities equal collateral on both sides.

A $10 Yes buy from a fresh 50/50 pool returns 19.777768 shares, fee 0.05 USDC, Yes reserve 790.172232, No reserve 809.95. Both test suites hard-code that fill.

Winning shares pay $1 each after the 24 hour window. If the thesis resolves Yes, the JavaScript engine pays the fee pot pro-rata to coalition stakes. Details and the round diagram are in [RULES.md](RULES.md).

## Run the contract tests

Rust and cargo are required only for this step.

```bash
npm run contract
```

That runs `cargo test` for the shared market rules, then `cargo check` of `contract/near` for `wasm32-unknown-unknown`. The wasm target is a compile check. This repo does not commit a wasm binary, and it does not deploy. Deploy is intentionally not scripted. To put it on testnet later: build the wasm, deploy to an account you control, call `new` with an owner and a Quorum account, then `credit` balances (a production build would take USDC via `ft_on_transfer`). Point the server at it with `PENCILS_CONTRACT` and `NEAR_NETWORK`. Still do not put a private key in the repo.

## Layout

- `web/` the Pencils interface. Homepage scene is three.js r128 from the CDN.
- `engine/` market math and the state machine. No network.
- `server/` HTTP API, the swarm clock, dry Intents quotes, optional NEAR AI.
- `contract/` the NEAR contract.
- `design/` the handoff spec, tokens, and data model.
- `scripts/simulate.mjs` a deterministic swarm run.
- `data/state.json` created on first boot and gitignored. Delete it, or use Reset in Profile, to start over.

## API

- `GET /api/health`
- `GET /api/state`
- `GET /api/quote?amount=25&chain=eth&direction=deposit`
- `POST /api/bet` `{ marketId, side, amount, via }`
- `POST /api/agents` `{ name, kind }`
- `POST /api/agents/perm` `{ id, perm, on }`
- `POST /api/agents/limit` `{ id, limit }`
- `POST /api/stake` `{ marketId, agentId, amount }`
- `POST /api/counter` `{ marketId, agentId }`
- `POST /api/markets` `{ title, days, by }`
- `POST /api/deposit` and `POST /api/withdraw` `{ amount, chain }`
- `POST /api/override` `{ marketId, outcome }`
- `POST /api/reset`

`chain` is `eth`, `sol`, `base`, or `arb`.

## Hackathon notes

Code here is the submission project. Name, email, the NEAR payout account, and the X post stay blank until you fill them. See [SUBMISSION.md](SUBMISSION.md). Do not commit secrets.
