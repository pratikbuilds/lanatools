# Agent instructions

- Leave the code you touch clearer and more reliable. Follow existing patterns, fix the root cause, and keep changes within the task's scope.
- Before opening or updating a PR, verify the affected behavior and run the relevant checks. For a full repository check, use `bun run check`. Report what passed, what failed, and anything you could not verify in the PR.
- Do not commit application screenshots or include them in PR descriptions, attachments, or links unless the user explicitly requests them. Keep screenshots and visual verification artifacts local.
- For Solana TypeScript work, use `@solana/kit` and its current plugin APIs. Check the official Solana MCP server at `https://mcp.solana.com/mcp` for task-specific guidance when it is available; otherwise consult current official Solana documentation. Verify transaction confirmation, retry behavior, signing boundaries, and network-specific addresses where relevant.
- Integrate Pay Kit through its public APIs. Never modify, patch, vendor, or monkey-patch Pay Kit; document missing capabilities and seek an upstream API or fix.
- If blocked after reasonable investigation, ask the human a specific question. Explain the blocker, what you tried, and what decision or access is needed. Do not present unverified work as complete.
