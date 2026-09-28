import { defineConfig } from 'vite'
import viteReact from '@vitejs/plugin-react'

export default defineConfig({
  root: 'consent',
  plugins: [viteReact()],
  build: { outDir: '../dist', emptyOutDir: true },
})
