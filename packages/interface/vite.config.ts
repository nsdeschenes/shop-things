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
      // Keep generated routes type-checked; the default header includes @ts-nocheck.
      routeTreeFileHeader: [
        '/* oxlint-disable */',
        '// noinspection JSUnusedGlobalSymbols',
      ],
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
  // Release cold optimized modules before this application's browser crawl can stall.
  optimizeDeps: {holdUntilCrawlEnd: false},
  server: {
    // Electron's cooperative watcher owns updates before a document can replace drafts.
    hmr: false,
    host: '127.0.0.1',
    strictPort: true,
  },
  build: {
    outDir: '../electron/dist/renderer',
    emptyOutDir: true,
  },
});
