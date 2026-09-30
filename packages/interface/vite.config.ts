import {unplugin as stylex} from '@stylexjs/unplugin';
import {tanstackRouter} from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
    }),
    stylex.vite({
      useCSSLayers: {
        before: ['reset'],
        prefix: 'stylex',
      },
      dev: process.env.NODE_ENV === 'development',
      runtimeInjection: false,
    }),
    react(),
  ],
  server: {
    host: '127.0.0.1',
    strictPort: true,
  },
  build: {
    outDir: '../electron/dist/renderer',
    emptyOutDir: true,
  },
});
