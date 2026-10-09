import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { createServer, defineConfig } from 'vite'
import type { UserConfig } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { checkNetworkEnv } from './src/lib/networks'

const proxy = {
  '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
}

export function createWebConfig(network: string | undefined): UserConfig {
  const { id } = checkNetworkEnv({ SOLANA_NETWORK: network })
  // Never expose root secrets through envPrefix or a serialized env object.
  const define = { 'import.meta.env.SOLANA_NETWORK': JSON.stringify(id) }
  return {
    define,
    resolve: { tsconfigPaths: true },
    plugins: [
      tailwindcss(),
      tanstackRouter({ target: 'react', autoCodeSplitting: true }),
      viteReact(),
      {
        name: 'prerender-landing',
        apply: 'build',
        async transformIndexHtml(html: string) {
          const server = await createServer({
            configFile: false,
            root: import.meta.dirname,
            define,
            resolve: { tsconfigPaths: true },
            plugins: [viteReact()],
            appType: 'custom',
            optimizeDeps: { noDiscovery: true, include: [] },
            server: { middlewareMode: true, ws: false, watch: null },
          })
          try {
            const { render } = await server.ssrLoadModule('/src/prerender.tsx')
            return html.replace(
              '<div id="app"></div>',
              `<div id="app">${render()}</div>`,
            )
          } finally {
            await server.close()
          }
        },
      },
    ],
    server: { proxy },
    preview: { proxy },
  }
}

export default defineConfig(() => {
  const rootEnvPath = resolve(import.meta.dirname, '../../.env')
  const rootEnv = existsSync(rootEnvPath)
    ? parseEnv(readFileSync(rootEnvPath, 'utf8'))
    : {}
  return createWebConfig(process.env.SOLANA_NETWORK ?? rootEnv.SOLANA_NETWORK)
})
