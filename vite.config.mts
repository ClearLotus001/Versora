import { fileURLToPath, URL } from 'node:url';

import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { restoreStandardBackdropFilter } from './scripts/viteCss.mts';

function resolveManualChunk(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/');

  if (normalized.includes('/node_modules/')) {
    if (
      normalized.includes('/react/')
      || normalized.includes('/react-dom/')
      || normalized.includes('/scheduler/')
      || normalized.includes('/use-sync-external-store/')
    ) {
      return 'react-vendor';
    }
    return 'vendor';
  }

  return undefined;
}

function preserveBackdropFilterPlugin(): Plugin {
  return {
    name: 'versora-preserve-backdrop-filter',
    enforce: 'post',
    generateBundle(_options, bundle) {
      Object.values(bundle).forEach((entry) => {
        if (entry.type !== 'asset' || !entry.fileName.endsWith('.css')) return;
        const css = typeof entry.source === 'string'
          ? entry.source
          : Buffer.from(entry.source).toString('utf8');
        entry.source = restoreStandardBackdropFilter(css);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss({ optimize: false }), preserveBackdropFilterPlugin()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Restore the standard declaration after minification for Electron's
    // Chromium; the post-build plugin keeps both prefixed and standard forms.
    cssMinify: 'lightningcss',
    rollupOptions: {
      output: {
        manualChunks(id) {
          return resolveManualChunk(id);
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    watch: {
      ignored: [normalizePath(fileURLToPath(new URL('./output', import.meta.url))) + '/**'],
      ...(process.platform === 'win32'
        ? {
          usePolling: true,
          interval: 150,
        }
        : {}),
    },
  },
});
