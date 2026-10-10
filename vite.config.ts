// Renderer build (React 19). Main/preload are bundled separately by scripts/build.mjs (esbuild).
// The renderer is served from app://pevqori/ in production, hence the relative base.
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: '../../out/renderer',
    emptyOutDir: true,
    target: 'chrome130',
    // No source maps in shipped builds (PEVQORI_SOURCEMAP=1 for a local debugging build).
    sourcemap: process.env.PEVQORI_SOURCEMAP === '1',
    // Electron's Chromium supports <link rel="modulepreload"> natively.
    modulePreload: { polyfill: false },
    reportCompressedSize: false,
    chunkSizeWarningLimit: 2048,
  },
  server: {
    // Loopback only: the dev server must never be reachable from the LAN.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
