# Product (working draft)

## Vision

One remote MCP server for agents to use Solana. A user connects an agent once, approves what that client can do, and sees its activity in one app. Through that connection, agents can use Solana data, pay for services, prepare transactions, and send signed transactions. The user stays in control of access, spending, and signing.

We start with agentic payments under one roof. We will add payment URL routing, transaction tools, and data from Helius, Jupiter, Dune, and other useful sources. The goal is one connection that lets an agent do useful work on Solana, with a clear record of every call, credit used, payment, and transaction in the app.

## The problem

To do real work on Solana, an agent needs more than a chat interface. It needs access to chain and market data, paid services, wallets, and a way to prepare and send transactions. Today, users piece those parts together through separate tools, MCP connections, API keys, and payment setups. They repeat the setup for each agent client and lose a clear view of what the agent used, spent, or sent.

We provide one place to connect agents to Solana tools and to control what each connected client can do. The user can set spending limits, inspect usage and transaction activity, and revoke access.

## First user

A Solana power user who already asks AI agents to carry out tasks, often across a desktop client and a cloud agent. They want an agent to fetch data, call a paid service, or prepare a transaction without setting up a different MCP server and wallet flow for each task. Their first use of our product is a paid endpoint they can call without hours of local setup. As we add tools, the same connection supports more of the work they ask their agents to do.

## One MCP URL, one embedded wallet for payments, separate client limits

Every agent client connects to the same hosted MCP URL. OAuth links the client to the user's account. The user has one Privy embedded wallet and approves permissions and a spending cap for each client that connects. Two clients can use the same wallet with different caps.

Our server checks every paid call against that client's permissions and remaining approved amount. [Privy wallet policies](https://docs.privy.io/controls/policies/overview) add rules for what the wallet may sign. Our app keeps track of each client's spending across calls.

## Connected clients and activity

The app shows every client connected to the MCP endpoint, its permissions, approved spending cap, amount spent, and amount remaining. The user can change a client's limit or revoke its access. For each client, they can see tool calls, the provider used, paid and denied requests, payment results, and receipts. As Helius, Jupiter, and other data tools are added, the same view shows their calls and provider usage, including read credits where available.

## 1. Agentic payments

The first product is a simple way for agents to pay for useful endpoints and return the results through one MCP connection.

1. The user creates and funds their embedded wallet.
2. They connect an agent to the shared MCP URL and approve that client's permissions and spending cap through OAuth.
3. The agent finds an allowed paid endpoint, including endpoints discovered through the pay.sh catalog, and requests it.
4. Our server checks the price and payment details, pays from the embedded wallet within that client's cap, and returns the result.
5. The user sees the call, cost, result, and remaining cap in the app.

We start with a small list of allowed endpoints. A failed or unclear payment must not cause a second charge without checking what happened to the first one.

## 2. Jev payment URL router

The next step is a router that helps an agent reach the right payment URL for a requested service. A user should be able to ask for a paid result without finding and configuring each provider's URL themselves. We still need to define how URLs are selected and what choices the user can control.

## 3. Prepare and send transactions

For a swap or another on-chain transaction, our service constructs the transaction and gives the agent a link to share with the user. The user reviews it and chooses which wallet will sign and send it:

- Local wallet: hand the prepared transaction to a wallet on the user's device for signing and submission.
- Browser wallet: open the link in the user's browser, then sign and send with their browser wallet.
- Embedded wallet: sign and send through our service using the user's embedded wallet.

The review link can open in the user's browser or in the embedded browser using Preview. For example, a user asks an agent to make a swap. Our service prepares the swap transaction, the agent returns a Blink-style link, and the user reviews and sends it from their chosen wallet. The agent can then report the transaction result.

## Solana tools through one connection

Beyond the initial payment tools, the same MCP connection will give agents access to Helius, Jupiter, and Dune. An agent can use their data to inspect accounts and transactions, understand markets, answer questions, and help decide what to do next. It can then prepare a transaction for the user to review and sign through a supported wallet. The app shows which tools the agent called and the credits or usage each provider reported. We will add other Solana tools as users need them for real tasks.

## What we need to learn first

- Can a user connect an agent and complete a real paid call without setting up a local payment tool?
- Do users make more paid calls after the first one?
- Do users connect a second client and give it a different spending cap?
- Can users tell what each client did and how much of its cap remains?
- Which paid endpoints and Solana data tools do users ask for next, and do the activity and credit views help them manage usage?
