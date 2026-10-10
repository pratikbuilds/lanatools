import { defineConfig, mergeConfig } from 'vite'
import { createWebConfig } from '../vite.config'

// This server is used only by browser tests. Production never loads the auth stub.
export default defineConfig(() =>
  mergeConfig(createWebConfig('devnet'), {
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
    },
    server: {
      host: '127.0.0.1',
      port: 4174,
      strictPort: true,
      // Prepare dashboard modules before tests hold authentication pending.
      // Cold dev transforms otherwise outlast the skeleton visibility check.
      warmup: {
        clientFiles: ['./src/app.tsx', './src/components/dashboard/*.tsx'],
      },
    },
  }),
)
