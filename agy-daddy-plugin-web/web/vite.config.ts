import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const nodeEnv =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

export default defineConfig({
  base: nodeEnv.VITE_PUBLIC_BASE || './',
  plugins: [react()],
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
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'react-vendor';
          }
          return undefined;
        }
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
});
