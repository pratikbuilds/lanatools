# Dashboard: wallet, connected clients, and activity

Status, October 2, 2026: design agreed; P1 to P3 are implemented. P4, verification against devnet with a signed-in user, is not done. This fills in the "Activity and control" section of [agent-payments.md](agent-payments.md) for the web dashboard. The agreed design is the mockup at [mockups/dashboard-activity.html](mockups/dashboard-activity.html).

## Goal

A signed-in user can answer three questions without asking the agent:

1. How much money is in my wallet?
2. Which clients can spend from it, and how much does each have left?
3. What did each client call, what did it cost, and which calls were refused or failed?

Today the dashboard answers 1 and part of 2. Question 3 is the product's observability promise and has no UI.

## What exists today

**Recorded, but not shown.** `payment_activity` (`apps/api/src/db/schema.ts`) has one row per `pay_http` call: client, method, origin, path, protocol, status (`free`, `refused`, `reserved`, `paid`, `released`, `uncertain`, `failed`), network, mint, reserved and settled amounts, transaction signature, HTTP status, error, and timestamps. Request and response bodies and query strings are never stored. No API route reads these rows; they are only summed into each client's `spent` and `reserved`.

**The live dashboard** (lanatools.sh, devnet, seen October 2):

- One 40rem column of three stacked boxes on a 1500px-wide window.
- "Agent payments" was off while Codex was connected and "last used 26 minutes ago" with $0.00 spent. Those calls were free or refused, and the page cannot say which or why.
- The deposit address and its help text take more room than the balance and the clients together.

**Not recorded.** Discovery tools (`whoami`, `list_catalog`, `search_catalog`, `get_catalog_entry`) write nothing. Catalog attribution (`catalog_fqn`, `catalog_endpoint`) is planned in [paysh-catalog-discovery.md](paysh-catalog-discovery.md) P2 and does not exist yet.

## Data hierarchy

The design follows how the data nests:

1. **Wallet**: one balance. Everything else is a child of it.
2. **Clients**: each connected client is a budget drawn from the wallet (limit, spent, left).
3. **Calls**: each call belongs to one client.

Permissions is a setting on the wallet, not data, so it lives in Settings.

## Decisions

Content and behaviour:

- The connecting party is a "client", as in product.md: "Connected clients", "Connect a client", "All clients".
- Activity shows calls that have ended: paid, free (the endpoint asked for nothing), refused (LanaTools declined before signing), and failed (the endpoint could not be reached). Refused and failed calls show the reason already recorded for them; nothing extra is stored. Payments in progress, and payments that were started and released, are bookkeeping for the limit and are not shown. Discovery tool calls are out of scope.
- No "held" figure anywhere. A client shows spent, limit and left.
- The spent total sits in the Connected clients header, not beside the balance.
- The wallet block groups the balance with the wallet address (with copy) and Deposit. The network is a small chip.
- The recipient is not stored or shown. A paid call links to its transaction by signature.
- The SOL line is not on the wallet page; the Deposit drawer mentions it. Privy handles fees.
- Times are 12-hour with AM or PM ("2:31 PM").
- No icons, avatars or letter tiles in activity rows.
- Older calls load on scroll.
- The wallet, clients and activity refetch every 15 s, the interval the wallet balance already uses, and when the tab regains focus.
- Agent payments are on once set up; there is no on/off switch. Removing LanaTools access, in Settings, is the emergency stop.
- A limit is changed two ways, kept in sync: by dragging a tick ruler, as in Rare UI's AnimatedCounter demo, or by typing an exact amount. Either way the limit is shown with the AnimatedCounter and rolls live.
- Rare UI is credited in `README.md`, as its license requires a visible link to rareui.com.

Design rules that came out of the rejected rounds:

- Navigation holds destinations only. Wallet data never sits in a nav bar or sidebar.
- One focal point per level; not every section in an equal-weight box.
- Serious and professional. Lime means money that moved and the primary action; coral means a refusal. Neither is decoration.

## Design

Reference: Mercury's public demo (demo.mercury.com: Home, Accounts, Transactions, Cards) for the hierarchy and the row-opens-a-drawer rule, Ramp's virtual-card tiles for "spent / limit" with a bar, and Higgsfield's MCP page and Linear's MCP docs for connecting a client.

### Header

A Klein blue bar: wordmark, three destinations (Wallet, Activity, Settings) with the current one as a paper pill, and one account control: the user's initial, their email, and a caret that opens a menu with "Signed in as", the email, and Sign out. On a phone the control collapses to the initial.

### Wallet (home)

- **Wallet panel.** One bordered panel in two halves. Left: "Available", the USDC balance as the largest thing on the page (rolls up on load), and the network chip. Right: "Deposit USDC", one line of instruction, the wallet address with Copy, and the lime Deposit button, which opens the Deposit drawer.
- **Connected clients.** Header: the title, "N connected, $X spent in total", and "Connect a client". Then a bordered table with a tinted header row. Columns: client (name over approved host), spent of limit (a bordered bar and "$0.34 / $1.00"), left, last used, Manage. A client with nothing left shows its bar and "left" in coral. A row opens the client drawer.
- **Latest activity.** The five most recent calls in the same row format as the Activity page, with "View all activity".

### Activity

- Two totals (spent, calls) that follow the filters, and a calls-per-day heatmap for the last 12 weeks.
- Filters: outcome (All, Paid, Free, Refused, Failed) and client.
- Every call, grouped by day. Columns: time, client as text, request (host in ink, path in mute), protocol, outcome.
- A row opens the call drawer.
- A sentinel at the end fetches the next page when it scrolls into view; the list ends with "That is every call." Rows are fetched 50 at a time; this is a fetch batch, not a cap.
- States: loading skeleton, load error with retry, "No calls match these filters", and an empty state that names the next step and never shows illustrative rows.

**Outcome column.** A paid call shows the settled amount on a lime tag. A refused call shows "Refused" on a coral tag, with its reason on a second line in the row. A free call shows "Free" and a failed call "Failed", both in grey; a failed call also shows its reason.

The reasons are shown as recorded. Two of them print raw units today ("remaining limit of 660000 micro-USD", "charge of 10000 USDC base units"); rewording them belongs to the later look at how denials are recorded.

### Settings

Permissions: whether agent payments are set up, the signing rules, a retry when setup failed, and "Remove LanaTools access" behind a confirmation. Removal stops every client at once and removes the signer from the wallet; "Set up again" undoes it.

### Drawers

Clicking a row, or an action that needs detail, opens a drawer from the right; the page behind does not reflow. Use a native `<dialog>` so focus trapping and Escape come from the platform.

- **Client.** Name and host. The spending limit as a large rolling number with "left after spent" under it; the tick ruler; then the amount input and "Save limit". Choosing a limit below what is already spent warns that the client cannot pay until the limit is higher (the existing behaviour of `setClientLimit`, made visible). Then spent, what it can do, connected, last used, "View its activity" (opens Activity filtered to this client), and "Disconnect" with the existing confirmation.
- **Call.** Host and path, client and time. The amount as the large number, the reason on a refused or failed call, then request method and URL, protocol and network, the endpoint's HTTP status, and for paid calls the transaction signature with "View on Solana Explorer" and copy.
- **Deposit.** The address, Copy, the network, and the SOL balance for fees.
- **Connect a client.** Pick the client first, then one thing to copy. The clients and their setup are the landing page's own (`components/landing/copy-url.tsx`: Cursor, Claude, Codex, Grok, Cloud agent), so the two never disagree; the mockup's drafted steps are not used.

### Components

- **AnimatedCounter** (Rare UI) for the balance and the limit. It ships through the shadcn CLI: `bunx shadcn@latest add swamimalode07/rare-ui/animated-counter`. The web app was scaffolded with the TanStack CLI and has the `@/*` alias shadcn expects but no `components.json`, so add a minimal `apps/web/components.json` by hand (aliases to `@/components` and `@/lib`, CSS at `src/styles.css`) rather than running `shadcn init`, which would rewrite `styles.css`. Then run the add command and review the diff: it should add `src/components/ui/animated-counter.tsx` and nothing else, since `motion` is already installed. Limits can have sub-cent digits, so the counter uses two decimals and widens only when the value needs more.
- **Limit ruler.** Rare UI's demo drives the counter with a native range input laid invisibly over a row of tick marks: marks up to the position are dark, the position itself is a taller accent mark. Ours does the same in ink and Klein blue. The ruler runs from $0 to what the wallet can cover for that client: what the client has already spent plus the whole available balance. A limit is cumulative, so the balance alone would be too short for a client that has already spent more than the wallet now holds. The scale is straight and moves in cents. The input still takes any amount up to `MAX_CLIENT_LIMIT_MICRO_USD`; above the ruler's top it pins the ruler at the end and says the client can only pay what is in the wallet.
- **Heatmap.** Plain squares, as in the mockup: one per day, darker for more calls. Rare UI's GitHub activity component was considered and left out; the squares need no dependency and no second imported component.

## API

**`GET /api/activity`**, behind `privyAuth`, mounted beside `/api/mcp/clients` in `worker.ts` and `worker.local.ts`.

- Query: `client` (client ID), `outcome` (`paid`, `free`, `refused` or `failed`), `before` (cursor).
- Response, defined in `packages/contracts`: `items`, `nextCursor`, and `totals` for the current filter (calls, spent).
- Only `paid`, `free`, `refused` and `failed` rows are returned. `reserved`, `uncertain` and `released` rows are bookkeeping for the client's limit and stay out of the dashboard.
- Rows are selected by `privy_user_id`, so one user can never read another's activity. The join to `mcp_grant` on user and client supplies the client name and whether the grant is still active; a disconnected client keeps its rows.
- The cursor is `(created_at, id)`, so rows created in the same millisecond page correctly.

**`GET /api/activity/days`** returns, for the last 12 weeks, one entry per day that had calls: the day, the call count, and the amount spent. Days are bucketed in UTC.

**Clients.** `GET /api/mcp/clients` is unchanged. The page shows "left" as limit minus spent minus reserved, so it never promises money the client cannot use, and does not show the reserved figure. While a payment is unresolved, spent plus left can be less than the limit by that payment's amount; this is accepted.

**Migration 0007.** One index, `payment_activity (privy_user_id, created_at, id)`. Read backwards it is newest first with the ID breaking ties, which is the feed's order. The existing index starts with user, client, status and does not serve a time-ordered read. No new columns.

## Payments on by default

Today the LanaTools signer is attached only when the user presses "Turn on" (`enablePaymentSigner`: the server prepares a policy-bound signer, the user's Privy session calls `addSigners`, the server confirms). It starts off, so a newly connected client is refused until the user finds the switch.

- Attach the signer as part of wallet setup: right after the wallet is created, and on dashboard load for any wallet whose payments are not on.
- Access the user removed (status `disabled`) stays removed. The server refuses automatic setup for it; only "Set up again" restores it.
- Attaching has to run in the user's signed-in browser session. It is attempted once per visit, without a click. Still to verify in P4: whether Privy's `addSigners` completes without a click or a prompt. If it needs one, it folds into the "Create wallet" button and a one-time "Finish setup" step.
- There is no on/off switch. One client is stopped by disconnecting it or by its limit; every client by removing LanaTools access.
- If attaching fails, Settings says so and retries it.

## Known gap

A paid call is listed once its payment is verified on chain. If verification could not finish during the call, the payment is settled later, the next time the same client makes a paid call, and only then appears in Activity. Closing that would mean settling stale payments when the dashboard loads; it touches payment code and is a separate change.

## Build order

Each phase is verifiable on its own.

### P1: activity API

- Migration 0007, `listActivity` and `activityDays` in `payments/activity.ts`, the two routes in `routes/activity.ts`, and the contract types.
- Tests with `test-database.ts`: paging across equal timestamps, each filter, totals, a second user's rows never returned, a disconnected client's rows still returned with its name, and payments in progress or released never returned.

### P2: shell, wallet page, clients

- Routes: `/dashboard` (Wallet), `/dashboard/activity`, `/dashboard/settings` under one layout with the header and account menu.
- Wallet panel, Connected clients table, the drawer, the client drawer with the limit editor, Deposit and Connect a client.
- `components.json`, AnimatedCounter, README credit.
- `AgentPayments` moves to Settings; the signer is attached at wallet setup.
- Existing `connected-apps.test.tsx` and `dashboard-view.test.tsx` cases kept and updated to the new names.

### P3: activity

- Latest activity on the Wallet page; the Activity page with totals, heatmap, filters (in the route's search params), day groups, scroll loading, and the call drawer.
- Render tests in the existing `renderToString` style for each outcome and each state.

### P4: verification

- `bun run check`.
- Local web, api and mcp against devnet; the user signs in once. If a call needs SOL, top the wallet up with about 0.1 SOL from the local Solana CLI wallet.
- With the hosted devnet merchant, make a paid call, a free call, and a call above `max_usd`, and confirm each appears with the right outcome, amount and reason.
- Change a limit and watch the number roll; set one below spent and confirm the warning.
- The devnet transaction link opens the right transaction on the right cluster.
- Screenshots at desktop and phone widths.

## Out of scope

- Recording discovery tool calls.
- Catalog provider names in the feed (paysh-catalog-discovery P2).
- Export, search and date-range filters.
- Any change to how payments are signed, reserved or settled.
