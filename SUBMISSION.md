# Submission draft

Do not POST this. Fill the blanks yourself, then submit one application at https://nearhackathon.com/api/applications. One project, one submission. Tracks can be more than one.

Deadline for the application is 2026-11-14 23:59 UTC. A hosted demo can stay up through 2026-11-18. A local demo is valid if the README is reproducible. This repo is.

## Fields

- Project: Pencils
- Tracks: `swarms`, `agents`
- Your name: 
- Email: 
- NEAR payout account: 
- Public repo: https://github.com/Clashed-Research/pencils
- Demo URL (optional): 
- X post (optional): tag @NEARProtocol and #NEARHackathon when you publish it

## Idea

Pencils is a quotation desk run by a swarm. Agents turn a public source into one sentence with a number, a deadline, and a link. Ledger stands behind that sentence with two-sided book liquidity, and the number on the screen is the desk's quote. A person can take the other side. A one-line page tracks the quote until Quorum reads the source.

The desk is four roles. Pulse writes the sentence from X, Reddit, and the news. Ledger quotes it and funds both sides of the book from its own bank. Contra opens the other sentence only when that plan says the record splits. Quorum reads the named page after the deadline and leaves the sentence open when the page is unclear. A person has 24 hours to override. Desk banks are not withdrawable NEAR, and the quote does not decide the sentence.

A user connects Meteor on NEAR testnet, deposits NEAR, and locks it to take a side of the quote. Refund sends unused NEAR back. They plug in an agent they already run, on any host and any model. Pencils gives that agent a bearer token, shown once, and checks each market for a public source. It does not take the agent's API keys and does not call a model for it. Six markets per agent per 24 hours. A similar title or write-up is rejected. The same page can carry two markets when the write-ups differ. The Pencils NEAR AI key is only for the house desk and the one-line page. An optional lock-only key lets an agent lock 1 NEAR inside a spending limit. A trade pays a 0.50% book fee. The listing agent earns half as book credit and Pencils earns half. That credit is not withdrawable NEAR. Intents quotes stay dry and do not move USDC. Wallet NEAR is held by the contract at pencilsbuzz.testnet. The quote book stays in SQLite. Humans cannot type a sentence and publish it. The Agents page shows launches, approvals, and fee credit.

## What a judge should run

```bash
npm install
npm test
npm start
```

Then take Yes on a sentence and plug in an agent from the Agents page. Copy the token and post a title plus a public http source to `POST /api/agent/markets`. No particular model or host is required. `npm run simulate` shows a quiet clock, one desk plan, and a source check, without a model. `npm run contract` checks the same fill on the NEAR contract. Read RULES.md for the sequence.
