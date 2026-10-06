import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrivyProvider } from '@privy-io/react-auth'
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
} from '@privy-io/react-auth/solana'
import { getRouter } from './router'

const router = getRouter()
const queryClient = new QueryClient()
const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Application root is missing')

const app = (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
)

const appId = import.meta.env.VITE_PRIVY_APP_ID
ReactDOM.createRoot(rootElement).render(
  appId ? (
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
        plugins: [defaultSolanaRpcsPlugin()],
      }}
    >
      {app}
    </PrivyProvider>
  ) : (
    app
  ),
)
