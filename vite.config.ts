import { defineConfig } from 'vite'

export default defineConfig({
  // Relative paths so the app works from a GitHub Pages sub-folder.
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'esnext' },
})
