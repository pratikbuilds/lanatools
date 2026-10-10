import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
} from 'react'
import type { ReactNode } from 'react'

export const walletAddress = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
const unavailable = () => {
  throw new Error('Wallet mutations are disabled in responsive tests')
}
const Auth = createContext({ authenticated: true, login: () => {} })
export const PrivyProvider = ({ children }: { children: ReactNode }) => {
  const [authenticated, setAuthenticated] = useState(
    !new URLSearchParams(location.search).has('signed-out'),
  )
  return createElement(Auth.Provider, {
    value: { authenticated, login: () => setAuthenticated(true) },
    children,
  })
}
export const defaultSolanaRpcsPlugin = () => ({})
export const toSolanaWalletConnectors = () => []
export const usePrivy = () => {
  const [ready, setReady] = useState(
    () => !new URLSearchParams(location.search).has('loading'),
  )
  useEffect(() => {
    const restore = () => setReady(true)
    window.addEventListener('test:privy-ready', restore)
    return () => window.removeEventListener('test:privy-ready', restore)
  }, [])
  return {
    ready,
    authenticated: useContext(Auth).authenticated,
    user: {
      id: 'responsive-test',
      google: { name: 'mobile-layout-test-account@example.com' },
      linkedAccounts: [
        {
          type: 'wallet',
          chainType: 'solana',
          walletClientType: 'privy',
          address: walletAddress,
        },
      ],
    },
    getAccessToken: async () => 'responsive-test',
    logout: unavailable,
  }
}
export const useSigners = () => ({
  addSigners: unavailable,
  removeSigners: unavailable,
})
export const useCreateWallet = () => ({ createWallet: unavailable })
export const useExportWallet = () => ({ exportWallet: unavailable })
export const useWallets = () => ({ wallets: [] })
export const useSignTransaction = () => ({ signTransaction: unavailable })
export const useConnectWallet = () => ({ connectWallet: unavailable })
export const useLoginWithOAuth = () => {
  const { login } = useContext(Auth)
  const [loading, setLoading] = useState(false)
  return {
    initOAuth: async () => {
      setLoading(true)
      login()
      await new Promise<void>((resolve) => {
        window.addEventListener('test:oauth-complete', () => resolve(), {
          once: true,
        })
      })
      const url = new URL(location.href)
      url.searchParams.delete('privy_oauth_code')
      url.searchParams.delete('privy_oauth_state')
      url.searchParams.delete('privy_oauth_provider')
      window.history.replaceState({}, '', url)
      setLoading(false)
    },
    loading,
  }
}
export const useLoginWithSiws = () => ({
  generateSiwsMessage: unavailable,
  loginWithSiws: unavailable,
})
