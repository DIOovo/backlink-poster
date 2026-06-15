import path from 'path';
import { defineConfig } from 'vite';

/** Separate IIFE build for MV3 content script (classic script, no type: module). */
export default defineConfig({
  build: {
    emptyOutDir: false,
    outDir: 'dist',
    minify: false,
    sourcemap: true,
    lib: {
      entry: path.resolve(__dirname, 'src/content.ts'),
      formats: ['iife'],
      name: 'AIFillContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: {
        extend: true,
        inlineDynamicImports: true,
      },
    },
  },
});
