import { Suspense, use } from 'react'
import ReactDOM from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { PrivyProvider } from '@privy-io/react-auth'
import {
  defaultSolanaRpcsPlugin,
  toSolanaWalletConnectors,
} from '@privy-io/react-auth/solana'
import { getRouter } from './router'

const rootElement = document.getElementById('app')
if (!rootElement) throw new Error('Application root is missing')

const router = getRouter()
// Route pages are split into their own chunks. Privy starts while the first
// page's chunk downloads; until it arrives, the boot screen index.html
// painted stays up, so the page never goes blank.
const boot = rootElement.innerHTML
const firstPage = router.load()
function Pages() {
  use(firstPage)
  return <RouterProvider router={router} />
}
const queryClient = new QueryClient({
  // Matches the dashboard's polling, so moving between pages reuses data.
  defaultOptions: { queries: { staleTime: 15_000 } },
})

const app = (
  <QueryClientProvider client={queryClient}>
    <Suspense
      fallback={
        <div className="contents" dangerouslySetInnerHTML={{ __html: boot }} />
      }
    >
      <Pages />
    </Suspense>
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
        // Privy's Solana signing flow needs an RPC for the chain it signs on
        // and throws inside its own tree without one. Its defaults cover
        // devnet and mainnet; the dashboard's own reads still go through the API.
        plugins: [defaultSolanaRpcsPlugin()],
      }}
    >
      {app}
    </PrivyProvider>
  ) : (
    app
  ),
)
