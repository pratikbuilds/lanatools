import { createServer, defineConfig, loadEnv } from 'vite'
import type { IndexHtmlTransformContext, Rollup } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { checkNetworkEnv } from './src/lib/networks'

// The landing page is a dynamic import in main.tsx, so the browser would only
// find its chunks after the entry runs. Preload them on / alone; app pages
// never load the landing code.
function landingPreload(
  bundle: Rollup.OutputBundle | undefined,
  entry: Rollup.OutputChunk | undefined,
) {
  if (!bundle || !entry) throw new Error('Landing preload needs the bundle')
  const chunks = Object.values(bundle).filter((c) => c.type === 'chunk')
  const landing = chunks.find((c) =>
    c.facadeModuleId?.endsWith('/src/components/landing/page.tsx'),
  )
  if (!landing) throw new Error('Landing page chunk is missing')
  const closure = (start: Rollup.OutputChunk) => {
    const seen = new Set<string>()
    const visit = (fileName: string) => {
      if (seen.has(fileName)) return
      seen.add(fileName)
      const chunk = bundle[fileName]
      if (chunk?.type === 'chunk') chunk.imports.forEach(visit)
    }
    visit(start.fileName)
    return seen
  }
  const loaded = closure(entry)
  const files = [...closure(landing)].filter((f) => !loaded.has(f))
  return `<script>if(location.pathname==='/')${JSON.stringify(files)}.forEach(function(f){var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href='/'+f;document.head.appendChild(l)})</script>`
}

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
        async transformIndexHtml(html: string, ctx: IndexHtmlTransformContext) {
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
            return html
              .replace(
                '</head>',
                `${landingPreload(ctx.bundle, ctx.chunk)}</head>`,
              )
              .replace(
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
