import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function ileBanner() {
  const metaPath = resolve(__dirname, 'tampermonkey.meta.js');
  const banner = readFileSync(metaPath, 'utf-8').trim();

  return {
    name: 'ile-banner',
    generateBundle(options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith('.js')) {
          chunk.code = `${banner}\n\n${chunk.code}`;
        }
      }
    },
  };
}

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.js'),
      name: 'ImmersiveLyricEngine',
      formats: ['iife'],
      fileName: () => 'immersive-lyric-engine.user.js',
    },

    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    minify: false,

    rollupOptions: {
      output: {
        exports: 'none',
      },
    },
  },

  plugins: [ileBanner()],
});