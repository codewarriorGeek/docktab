# DockTab

A hands-free money assistant for truck drivers. The driver says what happened at the dock; DockTab bills detention, pays the lumper and answers "has the broker paid me?" through PayPal. Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

The name: the **dock** is where drivers wait unpaid, and a **tab** is the running bill. DockTab keeps the tab for the time at the dock and makes sure someone pays it.

> Work in progress. Everything runs in the PayPal sandbox; no real money moves.

## What it does

| Driver says | DockTab does | PayPal |
|---|---|---|
| "I've been stuck at the Columbus dock all morning, bill the broker." | Works out billable detention from the truck's arrival, the appointment and the free time in the rate confirmation, then bills the broker | Invoicing v2: create + send (through the PayPal Agent Toolkit) |
| "Lumper wants 150 dollars for load 1042." | Pays the unloading crew | Payouts |
| "Has Prairie paid me for Indianapolis?" then "Yes, remind them." | Checks the invoice and chases the broker | Agent Toolkit: list/get invoices, invoice reminder, transactions |

An AI agent plans each request and calls the tools; amounts and times come from code, never from the model. A dispatcher board shows each load's detention clock, invoice and lumper payout, refreshed from PayPal.

## How it meets the judging criteria

| Criterion | Where to see it |
|---|---|
| Technical | PayPal Invoicing v2 (create, send, get, list, reminder), Payouts for the lumper, transaction search; tool calls are shown live in the driver's step trace; amounts come from code, not the model |
| Design | One driver screen (voice first, big mic button) and one dispatcher board; no settings pages |
| Impact | Drivers wait unpaid at docks (detention). The board shows money billed and money recovered per load |
| Idea | A driver speaks a detention claim and it becomes a sent PayPal invoice, with the dock timeline as evidence |
| Presentation | A video under 3 minutes covering the problem, the three flows live, and the PayPal sandbox showing the invoice and payout |

## Run it locally

Requirements: Node.js 22, a PayPal developer sandbox app (Invoicing enabled) and an API key for the AI model.

```sh
npm install
cp .env.example .env.local   # PayPal sandbox client id and secret, sandbox account emails
npm run build && npm start
```

`node --env-file=.env.local scripts/smoke.mjs` checks the PayPal sandbox credentials (token, order capture, invoice create and send) before you start.

## License

MIT
