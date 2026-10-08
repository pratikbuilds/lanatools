#!/bin/bash
# Serves the testbed merchant on devnet. pay keeps the gateway's fee payer in
# $HOME, so HOME must be a persistent volume or every deploy needs new SOL.
set -euo pipefail

: "${RECIPIENT:?Set RECIPIENT to the wallet that receives payments}"
RPC_URL="${DEVNET_RPC_URL:-https://api.devnet.solana.com}"
DEVNET_GENESIS=EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG
export HOME="${PAY_HOME:-/data}"

# A mainnet RPC would verify payments against real funds.
genesis=$(curl -fsS "$RPC_URL" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"getGenesisHash"}' |
  sed -n 's/.*"result":"\([^"]*\)".*/\1/p')
if [ "$genesis" != "$DEVNET_GENESIS" ]; then
  echo "$RPC_URL is not Solana devnet (genesis $genesis)" >&2
  exit 1
fi

mkdir -p "$HOME"
spec="$HOME/merchant.yaml"
bun /app/src/merchant-server.ts --write-gateway-spec "$spec"

fixture_pid=
gateway_pid=
cleanup() {
  # pay 0.28 ignores SIGTERM. Stop both children when either exits.
  kill -KILL ${fixture_pid:+"$fixture_pid"} ${gateway_pid:+"$gateway_pid"} 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
bun /app/src/merchant-server.ts &
fixture_pid=$!
for attempt in {1..50}; do
  if curl -fsS http://127.0.0.1:1403/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null || [ "$attempt" -eq 50 ]; then
    echo 'merchant fixture server did not start' >&2
    exit 1
  fi
  sleep 0.1
done

# On first start pay creates the fee payer and exits until it holds SOL; its
# address is in the error. Send it devnet SOL and the service restarts.
pay gate api "$spec" --no-register \
  --bind '127.0.0.1:1404' --rpc-url "$RPC_URL" --recipient "$RECIPIENT" &
gateway_pid=$!
wait -n "$fixture_pid" "$gateway_pid"
exit 1
