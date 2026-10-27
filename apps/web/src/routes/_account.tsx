import { PrivyProvider } from '@privy-io/react-auth'
import type { PrivyClientConfig } from '@privy-io/react-auth'
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
} from '@privy-io/react-auth/solana'
import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_account')({ component: AccountLayout })

const appId = import.meta.env.VITE_PRIVY_APP_ID

// Stable for the life of the page. A new object each render makes Privy
// recompute its app config, and WalletConnect is an Ethereum connector this
// Solana-only login does not use.
const privyConfig: PrivyClientConfig = {
  loginMethods: ['google', 'wallet'],
  appearance: {
    walletChainType: 'solana-only',
    walletList: ['phantom', 'solflare', 'backpack', 'detected_solana_wallets'],
  },
  externalWallets: {
    solana: {
      connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }),
    },
  },
  embeddedWallets: { solana: { createOnLogin: 'off' } },
  // Privy's signing flow requires an RPC; dashboard reads use the API.
  plugins: [defaultSolanaRpcsPlugin()],
}

function AccountLayout() {
  if (!appId) return <Outlet />

  return (
    <PrivyProvider appId={appId} config={privyConfig}>
      <Outlet />
    </PrivyProvider>
  )
}
