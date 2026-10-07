import { defineConfig, mergeConfig } from 'vite'
import appConfig from '../vite.config'

// This server is used only by browser tests. Production never loads the auth stub.
export default defineConfig(async (env) =>
  mergeConfig(await appConfig(env), {
    root: new URL('..', import.meta.url).pathname,
    resolve: {
      alias: [
        {
          find: /^@privy-io\/react-auth(?:\/solana)?$/,
          replacement: new URL('./privy.ts', import.meta.url).pathname,
        },
      ],
    },
    define: {
      'import.meta.env.VITE_PRIVY_APP_ID': JSON.stringify('responsive-test'),
      'import.meta.env.VITE_SOLANA_NETWORK': JSON.stringify('devnet'),
    },
    server: { host: '127.0.0.1', port: 4174, strictPort: true },
  }),
)
