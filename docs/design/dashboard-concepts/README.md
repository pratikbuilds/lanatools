# Wallet dashboard mockups

**`e-shift.html` (Shift) is the final design** for the dashboard Wallet page. The other files are earlier explorations kept for reference.

| File            | Status    | What it is                                                                                                                                                                        |
| --------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e-shift.html`  | Final     | Brand light and dark themes, original header with underline tabs, wallet block (balance, address, deposit), scalable clients table, activity filters, status bar, side icon field |
| `wallet.html`   | Reference | Clean Mercury/Ramp-style page in Manrope                                                                                                                                          |
| `d-arcade.html` | Reference | Playful pixel style with a coin animation and energy-bar limits                                                                                                                   |
| `index.html`    | —         | Links all three                                                                                                                                                                   |

`data.js` holds sample data for `d-arcade.html`. All pages use sample data, and Shift and Arcade simulate a live paid call every few seconds.

## View locally

Start the `design-concepts` server from `.claude/launch.json`, or run:

```bash
python3 -m http.server 4800 -d docs/design/dashboard-concepts
```

Then open http://localhost:4800/.

## Shift: panels and edge states

- Click a client row or its Manage button to open the client panel: money left, an inline limit editor, recent calls, connected and last used times, and Disconnect.
- Click an Activity row to open the call panel. Paid calls show a sample transaction signature with a Solana devnet explorer link. The signatures are made up, so the explorer page will not find them.
- The panel closes on Escape, the close button, or the backdrop.
- The Mock control at the bottom left switches between sample data, low balance, zero balance and no clients. Add `?state=low`, `?state=zero` or `?state=none` to the URL to open a state directly.
- At most one notice shows at the top. Low balance means the balance is below what the clients can still spend within their limits. A client at its limit shows when the balance is fine. At zero, the wallet block asks for a deposit instead.

## Open questions before building Shift into `apps/web`

- What counts as "Working now" for a client (for example, a paid or free call in the last 5 minutes). The app records only "last used" today.
