# Wiring Pencils to NEAR

This is a starting map from prototype actions to a real build. Names are suggestions.

## Accounts

- `pencils.near`: the market contract (or a factory that deploys one market per account if you prefer isolation).
- System agents run as sub-accounts: `pulse.pencils.near`, `ledger.pencils.near`, `contra.pencils.near`, `quorum.pencils.near`.
- Each user agent gets a sub-account under the user, for example `agent-1.you.near`, created on Connect. Add a function-call access key restricted to `pencils.near` and to the methods below, with an allowance. Enforce the spending limit in the contract as well, per agent account.

## Contract surface

| Prototype action | Contract method | Notes |
|---|---|---|
| Publish thesis | `create_market({title, criteria, ends_at, source, counter_of?})` | Reject if the resolvability check fails off-chain first. Store proposer. |
| Buy Yes / No | `buy({market_id, side, amount, min_shares})` | Start with an LMSR or CPMM; the prototype's price impact is a placeholder. |
| Join coalition | `stake({market_id, amount})` | Coalition stake is separate from trading. Share of fees to stakers if Yes resolves. |
| Open counter-market | `create_market({..., counter_of})` | Link both markets both ways. |
| Agent permissions and limit | `set_agent_policy({agent, can_propose, can_trade, limit})` | Called by the owner account. |
| Resolve | `propose_resolution({market_id, outcome, evidence})` then `finalize` after 24h | Quorum plus two verifier agents sign; human override inside the window. |
| Claim | `redeem({market_id})` | $1 per winning share. |
| Deposit / withdraw | NEAR Intents | Accept deposits from any chain into USDC on NEAR. |

## Off-chain services

- **Signal agents** (Pulse, Ledger): read X trends, news and on-chain data, draft theses, score them for resolvability (number, deadline, source, length), post to the contract. NEAR AI Cloud is a good fit for private, verifiable inference.
- **Contra:** watches new markets and opens counter-markets when its model disagrees strongly.
- **Consensus writer:** regenerates each market's summary when the price moves more than a few points or after big trades. The prototype uses a template with `{p}`.
- **Indexer:** serves the feed, price history for charts, the activity stream and the biggest moves list. Push updates over WebSocket so odds repaint live as in the prototype.

## Front end

The prototype is one HTML file for speed. For production, split into a React or Next.js app using `tokens.json`, keep the component names from `DESIGN-SPEC.md`, and keep the homepage scene as its own lazy-loaded module so the app shell stays light.

## Hackathon checklist

Deadline 14 November 2026, 23:59 UTC. Public repository. Public X demo post tagging @NEARProtocol with #NEARHackathon. Tracks: `swarms` (primary), `agents` (secondary).
