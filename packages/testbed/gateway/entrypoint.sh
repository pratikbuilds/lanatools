#!/bin/sh
# Serves the testbed merchant on devnet. pay keeps the gateway's fee payer in
# $HOME, so HOME must be a persistent volume or every deploy needs new SOL.
set -eu

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
sed "s/network: 'localnet'/network: 'devnet'/" /app/merchant.yaml >"$spec"
if ! grep -q "network: 'devnet'" "$spec"; then
  echo 'merchant.yaml no longer declares network localnet' >&2
  exit 1
fi

# On first start pay creates the fee payer and exits until it holds SOL; its
# address is in the error. Send it devnet SOL and the service restarts.
exec pay gate api "$spec" --no-register \
  --bind "0.0.0.0:${PORT:-1402}" --rpc-url "$RPC_URL" --recipient "$RECIPIENT"
