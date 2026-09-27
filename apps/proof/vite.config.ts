import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'

// Local-only proof pages. Never built or deployed with the product.
export default defineConfig({
  plugins: [viteReact()],
  server: {
    // Pay Kit proof server (`bun run testbed:paykit`).
    proxy: { '/testbed': { target: 'http://127.0.0.1:1403' } },
  },
})
