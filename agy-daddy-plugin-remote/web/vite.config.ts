import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const nodeEnv =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  base: nodeEnv.VITE_PUBLIC_BASE || '/',
  plugins: [preact()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
    target: 'es2022',
    minify: 'esbuild',
    cssMinify: true,
    sourcemap: nodeEnv.VITE_SOURCEMAP === 'true',
    reportCompressedSize: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
        manualChunks(id) {
          if (id.includes('@xterm/xterm') || id.includes('@xterm/addon-fit')) {
            return 'xterm';
          }
          if (id.includes('node_modules/preact/')) {
            return 'preact-vendor';
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5174
  }
});
