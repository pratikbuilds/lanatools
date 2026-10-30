# No-login access: tech spec

Status: Phase 0 checked in Claude Code (headless); Cursor and Codex untested.
Phases 1 to 4 built.

## 1. Goal

A user adds the LanaTools MCP URL to their agent and starts using it on day
one, with no account. The agent can read Solana data and prepare
transactions that its own wallet, or the user's browser wallet, signs. Login
is needed only for the embedded wallet, paid calls, spending limits and the
dashboard, and the client asks for it the first time the agent needs one of
those.

Customer ask (Oct 27): "Looks like I would need to sign up. Can he [the agent]
also do it himself?"

## 2. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | What works without login | Read tools, catalog tools, and transaction tools with `delivery: "local"` or `"link"` | The wallet's signature is the security; LanaTools never holds a key for these |
| 2 | What still needs login | Embedded wallet (`delivery: "embedded"`), paid `call`, spending limits, dashboard | LanaTools signs or spends here, so it must know the user and their limit |
| 3 | MCP URL | One URL, `https://mcp.lanatools.sh/mcp`, for both | One thing to paste and share |
| 4 | How login starts | A no-login call to a tool that needs login gets HTTP 401, so the client starts its normal OAuth login (§4) | Uses the login every client already supports; no mid-session scope upgrade |
| 5 | Sign in with a local wallet | Not built | Not needed to use the tools |
| 6 | Dashboard | Only after the user logs in or creates an account | No change from today |
| 7 | Get started | Landing "Get started" shows the MCP URL and the SKILL.md prompt, not `/sign-in` (Phase 4) | Day-one use without the dashboard |
| 8 | Abuse control | Per-IP rate limit on no-login calls, same Workers rate limiter the API already uses | No identity to limit by; protects the shared Helius credits |
| 9 | No-login activity | Not shown anywhere; it belongs to no account | There is no dashboard without login |
| 10 | Rate limit number | 30 tool calls per minute per IP; listing tools is free; a batch of several calls needs login, since the limit counts requests | Chosen 2026-10-30 |

## 3. Today (facts this spec relies on)

- Every `/mcp` request goes through `OAuthProvider` 1.1.0
  (`apps/mcp/src/index.ts`), which returns 401 to any `apiRoute` request
  without a token.
- Every tool runs through `withGrant` or `callTool` with a `GrantIdentity`
  (`apps/mcp/src/server.ts`). The API records each call against that grant.
- `transaction_request.creator_user_id`, `creator_client_id` and
  `creator_grant_id` are `not null` (`apps/api/src/db/schema.ts`).
  Idempotency is unique per `(creator_user_id, creator_client_id,
  idempotency_key)`.
- The transaction review page (`apps/web/src/components/transaction-review.tsx`)
  does not need login; the user signs with their browser wallet.
- The API already has Workers rate limiters (`apps/api/wrangler.jsonc`).
- Landing "Get started" and the header "Sign in" both go to `/sign-in`
  (`apps/web/src/components/landing/page.tsx`). Its steps start with "Create
  an account and fund the wallet."
- `apps/web/public/SKILL.md` tells the agent that login comes first.

## 4. How one URL works

The Worker looks at each `/mcp` request before `OAuthProvider`:

| Request | Goes to |
|---|---|
| Has `Authorization: Bearer …` | `OAuthProvider`, exactly as today (an invalid token still gets 401) |
| No token, any MCP method except the next row | The no-login server |
| No token, `tools/call` for a tool that needs login | HTTP 401 with the usual `WWW-Authenticate` header, so the client starts login |

The no-login `tools/list` also lists the tools that need login (`call`, and
`embedded` delivery is described), each saying "needs login". Without them
in the list the agent could never call one, and so the login would never
start. After login the client sends a token and gets today's full server.

What clients do (checked 2026-10-29):

- Clients start login only when the server answers 401, so a no-token server
  works in every client.
- Claude Code marks a server as needing login when it gets 401 and shows it
  in `/mcp`. Whether it opens login by itself mid-session, and what Cursor and
  Codex do, is untested. Phase 0 settles this before any build.
- The standard mid-session scope upgrade (403 `insufficient_scope`) is not
  handled by Claude Code or Cursor today, so this plan does not use it.

## 5. Phases

### Phase 0: prove the 401 login in real clients

A throwaway Worker on one URL: one tool works with no token, a second tool
answers HTTP 401 and points at a test OAuth server. Add it to Claude Code,
Cursor and Codex.

Record for each client: does it connect with no token, does the first tool
work, what happens on the 401 tool (login opens, a message, or nothing), and
does the agent's next call carry the token.

Done when: the table is filled in. If a client cannot log in this way, stop
and pick between a "run /mcp to log in" message for that client or the
two-URL fallback.

### Phase 1: no-login read tools

- In `apps/mcp/src/index.ts`, send no-token `/mcp` requests to `createServer`
  with no identity, per §4. Token requests are unchanged.
- No-login tools: Helius, Jupiter and Phoenix read tools and the catalog
  tools (`NO_LOGIN_TOOLS` in `apps/mcp/src/server.ts`). `whoami` says "not
  logged in". `send_feedback` needs login, because feedback is saved per
  connection.
- `call` is listed as "needs login" and answers 401.
- The API gets a no-login path for read tools that skips the grant check.
  Activity is recorded under `no-login`, with input and country, for usage
  analytics (2026-10-30). It is never shown in a dashboard.
- Per-IP rate limit (decision 10).
- Tests: tools with no identity, the 401 on `call`, the rate limit, and that
  token requests behave exactly as before.

Done when: an agent added with only the MCP URL lists Phoenix markets and
gets a Jupiter quote with no login, and calling `call` starts login.

### Phase 2: no-login transactions (local and link)

- Transaction tools, `send_transaction` and `get_transaction_status` work
  with no token, with `delivery` limited to `local` and `link`.
  `delivery: "embedded"` with no token answers 401.
- `transaction_request`: no migration. No-login rows store the creator
  `no-login` (`NO_LOGIN` in `apps/api/src/transactions/requests.ts`) as user
  and grant, so `liveAccess` and the review page treat them as available
  unless embedded, and the dashboard, which reads by user, never shows them.
  The creator client scopes the idempotency key: `wallet:<address>` for
  `local`, and a random `link:<uuid>` for `link`, whose keys are never reused.
- The transaction id, a random UUID as today, is the only way to reach a
  no-login row. No-login and logged-in callers cannot read each other's rows.
- The same per-IP limit as reads (30 calls per minute), shared.
- Tests: a local swap prepared and sent with no login, a link review signed
  in the browser, the 401 on `embedded`, and that logged-in transactions are
  unchanged.

Done when: an agent with its own keypair sends a transaction on devnet
through the MCP URL with no account. Met 2026-10-30 with a 0.001 SOL
`solana_transfer` (local delivery), signature
`2EyJC6xmz4sVNDfpcEGQkALybjyjEvxWa3wy9ygqUnnXDo8GxSP3vqp3NXphWdonWHubnsNNQG4ayMhFDQ1fd7GH`.
Swaps were not tested.

### Phase 3: SKILL.md and tool text

- Rewrite `apps/web/public/SKILL.md`: add the URL and start working; no login
  needed for data and own-wallet transactions; the client asks for login the
  first time a tool needs the LanaTools wallet or a paid call.
- Tool descriptions say what needs login.

### Phase 4: get started without the dashboard

- Landing "Get started" scrolls to (or opens) the connect block: the MCP URL
  with the client tabs that already exist (`copy-url.tsx`), and a one-line
  prompt to paste into any agent: "Read https://lanatools.sh/SKILL.md and
  connect to LanaTools."
- Steps become: 1. paste the URL into your agent, 2. ask it for Solana data
  or a transfer, 3. log in when you want the LanaTools wallet, paid APIs and
  limits. The client tabs are the existing `Install` component; the prompt is
  `SkillBox`, both in `copy-url.tsx`.
- Header "Sign in" stays and goes to the dashboard, as today.
- The dashboard's connect page (`connect-client.tsx`) is unchanged.

Done when: someone new goes from the landing page to a working Phoenix query
in their agent without opening `/sign-in`.

## 6. Not in scope

- Sign in with a local wallet.
- Moving no-login history into an account after login.
- Spending limits for local or link wallets (LanaTools does not sign, so a
  limit could not stop anything).
