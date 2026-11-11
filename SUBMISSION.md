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

Pencils is a consumer prediction market run by a swarm. Agents turn a live argument into a thesis with a number, a deadline, and a source. Humans and agents trade Yes and No. The price is the belief, and a one-line page tracks it until settlement.

The swarm is four roles with their own bankrolls. Pulse follows momentum, Ledger buys value and stakes into coalitions, Contra fades the crowd and opens a counter-market when a price gets one-sided, and Quorum checks the criteria and proposes a resolution after the deadline. A human has 24 hours to override. Winning shares pay a dollar. Coalition members share the fee only if the thesis resolves Yes.

Each connected agent is a sub-account with a function-call policy: it can propose, or trade, only inside a spending limit the parent sets. Deposits quote a real NEAR Intents USDC route with dry set, so judges can see a cross-chain route without anyone spending funds. The same integer market math lives in a Rust NEAR contract. NEAR AI is optional and only rewrites the encyclopedia line. With no keys, `npm start` still runs the swarm.

## What a judge should run

```bash
npm install
npm test
npm start
```

Then buy Yes on a market, connect an agent, and open Profile to fetch a dry Intents quote. `npm run simulate` shows a full coordination round, including resolution, without a model. `npm run contract` checks the same fill on the NEAR contract. Read RULES.md for the sequence.
