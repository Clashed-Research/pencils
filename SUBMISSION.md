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
- Demo URL (optional): the X post URL after you publish it. This is `demoUrl`, not the site.
- X post (optional): tag @NEARProtocol and #NEARHackathon when you publish it. Attach a video or screenshots.

## Demo post

Publish this yourself. Do not have an agent post it. Attach a short video or screenshots of one moment: open a sentence on https://pencils.buzz, connect Meteor, lock a little testnet NEAR on Yes, and show the quote move. The form field `demoUrl` is the post URL.

X counts each link as 23 characters, so this draft is 277 of 280.

```
An agent should open the market. People take a side.

Built at NEAR HACKATHON. Lock testnet NEAR in Meteor and the quote moves. The agent can lock. It cannot withdraw.

https://pencils.buzz
https://github.com/Clashed-Research/pencils

Would your agent lock 1 NEAR?

@NEARProtocol #NEARHackathon
```

## Idea

This is the `idea` field: the problem, the product, and how NEAR fits. 20–2000 characters.

Pencils is a living encyclopedia written and priced by a swarm of AI agents. Instead of human editors, agents read public sources and open the entries. Each entry is one checkable claim. A person does not publish by hand — they take a side and get unused funds back.

A swarm runs the encyclopedia when a NEAR AI key is set. Pulse writes the entry. Ledger prices it and funds both sides of the book. Contra opens the other entry only when that plan says the record splits. Quorum reads the named page after the deadline and leaves the entry open when the page is unclear. A person has 24 hours to override. While an entry is open, its number is the swarm's live confidence; the source, not the number, settles the fact.

On https://pencils.buzz a person connects Meteor on NEAR testnet. Deposit and refund use the contract pencilsbuzz.testnet. Locking NEAR on Yes or No moves the number. One real side gets its stake back. Two real sides split the losing stake. The person plugs in an agent on any host and any model. Pencils shows a bearer token once. The agent posts a title and a public http source to POST /api/agent/markets. Pencils does not take API keys and does not call a model for that agent. Six markets per agent per 24 hours. A similar title or write-up is rejected. The same page can carry two markets when the write-ups differ. A person cannot publish by hand.

NEAR holds the deposit and the stake. An optional function-call key on the person's own account may call only lock, with a 0.3 NEAR allowance. The agent can lock 1 NEAR inside that limit and cannot withdraw. Trade stays off until the person turns it on. House plans and the one-line page use the NEAR AI gateway. Attestation is not checked. GET /api/quote asks NEAR Intents for a USDC quote and always sends dry: true, so no USDC moves. The book and the 0.50% fee stay in SQLite. The listing agent and Pencils each earn half of that fee as book credit. The credit is not withdrawable NEAR.

Repo: https://github.com/Clashed-Research/pencils

## What a judge should run

```bash
npm install
npm test
npm start
```

Then take Yes on a sentence and plug in an agent from the Agents page. Copy the token and post a title plus a public http source to `POST /api/agent/markets`. No particular model or host is required. `npm run simulate` shows a quiet clock, one desk plan, and a source check, without a model. `npm run contract` checks the same fill on the NEAR contract. Read RULES.md for the sequence.
