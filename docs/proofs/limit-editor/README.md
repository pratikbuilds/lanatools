# Limit editor styling proof

Captured the actual `ClientDetail` / `LimitEditor` components in a temporary local Vite fixture, using the screenshot’s values: $0.06 limit, $0.015 spent, $0.003 reserved, and $0.085 wallet balance. Both comparison images show the amount input focused at the same viewport and scale. The fixture was removed after verification.

- [Before / after comparison](before-after.png)
- [Before](before.png) and [after](after.png)
- [Dark mobile](after-dark-mobile.png)
- [Light desktop](after-light.png) and [light mobile](after-light-mobile.png)

## Verification

- 19 editor and client-detail unit tests passed, including fractional-cent and sub-cent wallet endpoints.
- Web TypeScript, changed-file ESLint, and Prettier checks passed.
- Production web build passed with `VITE_SOLANA_NETWORK=devnet` (existing Vite config and bundle-size warnings).
- Chromium interaction checks passed: input focus and caret styling, transparent ruler, dragging, arrow keys, Home/End, exact wallet endpoint, rolling and settled digits, sub-cent input precision, invalid-input disabling, below-spend and above-wallet messages, pending/success/failed saves, reduced motion, and dark/light layouts at 390px without horizontal overflow. No browser errors.

Save states used a local mock callback. No authenticated backend request or real account limit was changed.

## Shared input follow-up

Audited every native input and select in the web app. The client search, withdrawal address, withdrawal amount, and activity client selector share `d-input`; they now use the same muted focus border and theme caret as the limit field. The early-access email already suppresses its input outline and indicates focus on its container. Button and link keyboard outlines remain intact.

Chromium checks passed for all four shared dashboard field styles in dark/light themes, invalid-state borders, typing/selection, retained button outlines, existing email container focus, reduced motion, and 390px layout. These checks used a temporary fixture with the production field classes and the actual early-access component, removed afterward. All 32 relevant unit tests and formatting checks passed.
