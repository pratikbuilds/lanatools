import { createServer, defineConfig, loadEnv } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { checkNetworkEnv } from './src/lib/networks'

const proxy = {
  '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
}

export default defineConfig(async ({ command, mode }) => {
  if (command === 'build') {
    checkNetworkEnv(loadEnv(mode, import.meta.dirname, 'VITE_'))
  }
  return {
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
})
