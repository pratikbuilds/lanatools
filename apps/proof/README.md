# Proof pages

Local-only pages for LanaTools proofs. They are not part of the product UI and
are never built or deployed. Put the public Privy app ID in the ignored
`apps/proof/.env.local` as `VITE_PRIVY_APP_ID`, then run:

```sh
bun run proof
```

and open `http://localhost:5174`.

- **Pay Kit payment (ADI-176):** run `bun run testbed start` and
  `bun --env-file=.env run testbed:paykit` (or `testbed:devnet start` and
  `testbed:paykit:devnet` for devnet), sign in, and use the payment buttons.
  The page sends your Privy access token only to the local proof server.
- **Privy policy proof (ADI-175):** copy a test token for `testbed:privy`.
