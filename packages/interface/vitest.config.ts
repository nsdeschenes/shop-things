import react from "@vitejs/plugin-react";
import { unplugin as stylex } from "@stylexjs/unplugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Compile StyleX without the Vite development server's CSS polling timer.
    stylex.rollup({
      useCSSLayers: { before: ["reset"], prefix: "stylex" },
      dev: false,
      runtimeInjection: false,
    }),
    react(),
  ],
  test: {
    environment: "jsdom",
    setupFiles: ["./test/setup.ts"],
  },
});
