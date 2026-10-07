import type { ReactNode } from 'react'

export const walletAddress = 'F8ypHfv7gs9JiHVnb51g7aVA2tmmC9ZpF5FdpChYjpV3'
const unavailable = () => {
  throw new Error('Wallet mutations are disabled in responsive tests')
}
export const PrivyProvider = ({ children }: { children: ReactNode }) => children
export const defaultSolanaRpcsPlugin = () => ({})
export const toSolanaWalletConnectors = () => []
export const usePrivy = () => ({
  ready: !new URLSearchParams(location.search).has('loading'),
  authenticated: true,
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
})
export const useSigners = () => ({
  addSigners: unavailable,
  removeSigners: unavailable,
})
export const useCreateWallet = () => ({ createWallet: unavailable })
export const useWallets = () => ({ wallets: [] })
export const useSignTransaction = () => ({ signTransaction: unavailable })
export const useConnectWallet = () => ({ connectWallet: unavailable })
export const useLoginWithOAuth = () => ({
  initOAuth: unavailable,
  loading: false,
})
export const useLoginWithSiws = () => ({
  generateSiwsMessage: unavailable,
  loginWithSiws: unavailable,
})
