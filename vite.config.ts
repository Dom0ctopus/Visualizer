import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // The browser's address reaches the backend (X-Forwarded-For), which
        // decides who may edit (server/src/editors.ts).
        xfwd: true
      }
    }
  },
  // `npm run prod:all`: the production build, same backend proxy.
  preview: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // The browser's address reaches the backend (X-Forwarded-For), which
        // decides who may edit (server/src/editors.ts).
        xfwd: true
      }
    }
  }
})
