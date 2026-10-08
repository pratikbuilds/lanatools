import { PrivyProvider } from '@privy-io/react-auth'
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
} from '@privy-io/react-auth/solana'
import { Outlet, createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/_account')({ component: AccountLayout })

const appId = import.meta.env.VITE_PRIVY_APP_ID

function AccountLayout() {
  if (!appId) return <Outlet />

  return (
    <PrivyProvider
      appId={appId}
      config={{
        loginMethods: ['google', 'wallet'],
        appearance: {
          walletChainType: 'solana-only',
          walletList: [
            'phantom',
            'solflare',
            'backpack',
            'detected_solana_wallets',
            'wallet_connect',
          ],
        },
        externalWallets: {
          solana: {
            connectors: toSolanaWalletConnectors({ shouldAutoConnect: false }),
          },
        },
        embeddedWallets: { solana: { createOnLogin: 'off' } },
        // Privy's signing flow requires an RPC; dashboard reads use the API.
        plugins: [defaultSolanaRpcsPlugin()],
      }}
    >
      <Outlet />
    </PrivyProvider>
  )
}
