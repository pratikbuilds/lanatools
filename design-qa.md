# Deposit modal design QA

final result: passed

## Visual evidence

- Source: selected first mockup with bold address ends and a plain QR, `/workspace/generated_images/exec-cd771286-a419-43cd-989f-89a952be9598.png`.
- Implementation: [desktop](docs/proofs/deposit-modal/desktop.png), [390px](docs/proofs/deposit-modal/mobile-390.png), [320px](docs/proofs/deposit-modal/mobile-320.png).
- Full-view comparison: `/workspace/lanatools/output/deposit-review/comparison.png`, source and desktop capture together.
- Both desktop images are 1487 × 1058 pixels at density 1. The implementation CSS viewport is 1487 × 1058. Mobile viewports are 390 × 760 and 320 × 760 at density 1.
- State: dark theme, Deposit USDC open. Desktop capture shows the idle copy action. Mobile captures show copy success. The preview mounts the real WalletPanel with a test session and mocked balances; production authentication is not bypassed or changed.

## Findings and accepted differences

No actionable P0/P1/P2 findings remain.

- Fonts and typography: existing mono headings, address and actions; existing sans body. First and last four address characters are bold and brighter; the middle stays regular. The full address wraps intact instead of truncating.
- Spacing and layout: QR first, scan instruction, address, primary copy action, then network and confirmation notes. The existing Withdraw modal's 26rem width, header, Close button, padding and border are retained rather than the mockup's enlarged presentation dimensions.
- Colors: existing dark/light theme tokens, ivory primary action, muted supporting copy. High-contrast black QR on white.
- Asset quality: actual generated vector QR with a four-module quiet zone, no logo. Standard Phosphor copy/status icons. An independent decoder reads the exact full address from a screenshot of the QR.
- Copy: the configured network is used throughout. This devnet preview intentionally says Solana devnet; mainnet builds say Solana mainnet. The illustrative mockup's fake address and footer are not product content.
- Focused visual review: inspected the desktop address/QR region and the 320px capture at full resolution. Address and controls remain visible, and the dialog has no horizontal overflow.

## Interaction verification

Browser smoke checks passed for:

- Dashboard, inline-modal and primary-button copying of the full address.
- Success feedback and clipboard-denial fallback with manually selectable text.
- Independent QR decoding to the full receiving address.
- Native modal focus containment and focus return to Deposit.
- Close, Escape and backdrop dismissal.
- Withdraw continuing to open in its existing modal.
- Layout at 390px and 320px, with the full address preserved.
- No browser page errors.

## Comparison history and remaining limits

Initial visual comparison found no actionable P0/P1/P2 differences after applying the accepted existing-modal sizing. No visual repair loop was required.

Physical-phone scanning in Phantom and an onchain deposit were not performed. The QR encodes a receiving address; the sender must select USDC and the displayed network in their wallet. No transaction signing or sending behavior is added.
