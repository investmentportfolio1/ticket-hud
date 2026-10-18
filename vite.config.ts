import { defineConfig } from 'vite'

export default defineConfig({
  // Relative paths so the app works from a GitHub Pages sub-folder.
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        // Stable name so the installed Even app shell can always load the latest code.
        entryFileNames: 'app.js',
        chunkFileNames: 'chunk-[hash].js',
        assetFileNames: '[name]-[hash][extname]',
      },
    },
  },
})
