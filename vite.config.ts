import path from 'path';
import { defineConfig } from 'vite';
import sourcemaps from 'rollup-plugin-sourcemaps';

export default defineConfig({
  build: {
    minify: false, // 便于在扩展里直接调试产物
    sourcemap: true,
    chunkSizeWarningLimit: 10240,
    rollupOptions: {
      // @ts-ignore
      plugins: [sourcemaps()],
      input: {
        background: path.resolve(__dirname, 'src/background.ts'),
        sidepanel:  path.resolve(__dirname, 'sidepanel.html'),
        options:    path.resolve(__dirname, 'options.html'),
        cache:      path.resolve(__dirname, 'cache.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
});
