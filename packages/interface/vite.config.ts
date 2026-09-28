import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
  build: {
    outDir: '../electron/dist/renderer',
    emptyOutDir: true,
  },
})
