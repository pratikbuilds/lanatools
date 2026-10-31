# Public Phoenix account page: tech spec

Status: decisions approved 2026-10-31; built, not yet deployed.

## 1. Goal

Anyone with a link can see a wallet's Phoenix account without logging in. After
a trade, the agent gives the user that link. No-login traders have no other
way to see their position in LanaTools.

## 2. Today

- The page is `/dashboard/perps/$address`. `/dashboard` sends signed-out
  visitors to `/sign-in`.
- `PerpsPage` (`components/dashboard/perps.tsx`) takes `userId`,
  `walletAddress` and `getAccessToken` from `useDashboardSession`, so it only
  renders inside the signed-in dashboard.
- `routes/phoenix.ts` runs all three routes behind `privyAuth`: account,
  candles and fills. Fills also takes the signed-in `userId`.
- A viewing page polls the account every 15 seconds and candles every 60.
- The account data is already public on Phoenix, and `phoenix_get_account`
  returns it to any agent with no login.

## 3. Decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| 1 | Who can view | Anyone, no login (chosen 2026-10-31) | No-login traders must be able to check a trade |
| 2 | URL | `https://lanatools.sh/perps/<wallet>`, outside `/dashboard`. The dashboard route stays for signed-in users | A public page must not load the dashboard session or shell |
| 3 | What it shows | Only what Phoenix makes public: account, positions, orders, candles and fills. No LanaTools data about any user | Public by address must expose nothing private |
| 4 | Rate limit | A new per-IP limiter (`PHOENIX_PUBLIC_LIMITER`) on the public routes, 120 requests a minute like `TRANSACTION_LINK_LIMITER` | The routes call Phoenix for us with no login. One open page makes about 6 requests a minute |
| 5 | Link in results | Confirmed Phoenix results carry `accountUrl`, built from the signing wallet | Agents should not build URLs |

## 4. Phases

### Phase 1: public API

Split the three routes out of `privyAuth`, behind the limiter. Fills must work
without a `userId`; anything that needs one stays signed-in only.

Done when: all three answer with no token, past the limit they answer 429, and
a test proves the public fills response holds no per-user data.

### Phase 2: public page

Make `PerpsPage` take what it needs as props instead of from the session, and
add the public route. Remove the signed-in-only links from the public view.

Done when: the page loads signed out, and the dashboard page is unchanged.

### Phase 3: link in results

Add `accountUrl`, and a line in the tool descriptions and `SKILL.md` telling
the agent to give it to the user after a trade.

Done when: a confirmed trade's result contains the link and it opens signed
out.
