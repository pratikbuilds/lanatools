# Proof pages

Local-only pages for LanaTools proofs. They are not part of the product UI and
are never built or deployed. Put the public Privy app ID in the ignored
`apps/proof/.env.local` as `VITE_PRIVY_APP_ID`, then run:

```sh
bun run proof
```

and open `http://localhost:5174`.

- **Pay Kit payment (ADI-176):** start Surfpool and
  `bun --env-file=.env run testbed:paykit`, sign in, and use the pay buttons.
  The page sends your Privy access token only to the local proof server.
- **Privy policy proof (ADI-175):** copy a test token for `testbed:privy`.
