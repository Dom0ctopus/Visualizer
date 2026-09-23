import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // @luxar/viewer loads its WASM module and web workers relative to its own
  // files (import.meta.url); Vite's dependency pre-bundling moves the JS and
  // breaks those paths.
  optimizeDeps: {
    exclude: ['@luxar/viewer']
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true
      }
    }
  }
})
