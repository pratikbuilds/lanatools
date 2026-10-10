import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'
import { createServer, defineConfig } from 'vite'
import type { IndexHtmlTransformContext, Rollup, UserConfig } from 'vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { checkNetworkEnv } from './src/lib/networks'

// Every page is a dynamic import (the landing page in main.tsx, app pages
// through the router), so the browser would only find a page's chunks after
// the entry runs, one round trip at a time. Preload them from the HTML
// instead: the landing page on / alone, and on any other path the app with
// that page's own route, so app pages never load the landing code.
const APP = '/src/app.tsx'
const ACCOUNT = '/src/routes/_account.tsx?tsr-split=component'
const PAGES: Array<[prefix: string, modules: Array<string>]> = [
  ['/', ['/src/components/landing/page.tsx']],
  ['/tx/', [APP, '/src/routes/tx.$linkId.tsx?tsr-split=component']],
  [
    '/sign-in',
    [APP, ACCOUNT, '/src/routes/_account/sign-in.tsx?tsr-split=component'],
  ],
  [
    '/dashboard',
    [
      APP,
      ACCOUNT,
      '/src/routes/_account/dashboard.tsx?tsr-split=component',
      '/src/routes/_account/dashboard/index.tsx?tsr-split=component',
    ],
  ],
  // Any other path: the app, which shows the router's not-found page.
  ['', [APP]],
]

function pagePreload(
  bundle: Rollup.OutputBundle | undefined,
  entry: Rollup.OutputChunk | undefined,
) {
  if (!bundle || !entry) throw new Error('Page preload needs the bundle')
  const chunks = Object.values(bundle).filter((c) => c.type === 'chunk')
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
  const pages = PAGES.map(([prefix, modules]) => {
    const files = new Set<string>()
    for (const id of modules) {
      const chunk = chunks.find((c) => c.facadeModuleId?.endsWith(id))
      if (!chunk) throw new Error(`Chunk for ${id} is missing`)
      for (const file of closure(chunk)) if (!loaded.has(file)) files.add(file)
    }
    return [prefix, [...files]] as const
  })
  // The first page whose prefix matches wins; "/" matches only itself and
  // "" matches everything.
  return `<script>;(function(){var p=location.pathname,pages=${JSON.stringify(pages)};for(var i=0;i<pages.length;i++){var k=pages[i][0];if(k==='/'?p==='/':p===k||p.indexOf(k.replace(/\\/$/,'')+'/')===0){pages[i][1].forEach(function(f){var l=document.createElement('link');l.rel='modulepreload';l.crossOrigin='';l.href='/'+f;document.head.appendChild(l)});return}}})()</script>`
}

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
        async transformIndexHtml(html: string, ctx: IndexHtmlTransformContext) {
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
            return html
              .replace(
                '</head>',
                `${pagePreload(ctx.bundle, ctx.chunk)}</head>`,
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
}

export default defineConfig(() => {
  const rootEnvPath = resolve(import.meta.dirname, '../../.env')
  const rootEnv = existsSync(rootEnvPath)
    ? parseEnv(readFileSync(rootEnvPath, 'utf8'))
    : {}
  return createWebConfig(process.env.SOLANA_NETWORK ?? rootEnv.SOLANA_NETWORK)
})
