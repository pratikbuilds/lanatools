import { defineConfig, loadEnv } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { checkNetworkEnv, checkRpcNetwork } from './src/lib/networks'

const proxy = {
  '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
}

export default defineConfig(async ({ command, mode }) => {
  if (command === 'build') {
    const env = loadEnv(mode, import.meta.dirname, 'VITE_')
    const { id, rpcURL } = checkNetworkEnv(env)
    // An RPC override may serve another network. Fail the build instead of
    // deploying a page whose balance reads always fail.
    if (env.VITE_SOLANA_RPC_URL) await checkRpcNetwork(rpcURL, id)
  }
  return {
    resolve: { tsconfigPaths: true },
    plugins: [
      tailwindcss(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      viteReact(),
    ],
    server: { proxy },
    preview: { proxy },
  }
})
