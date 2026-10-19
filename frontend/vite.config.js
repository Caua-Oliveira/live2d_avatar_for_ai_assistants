import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/static': 'http://127.0.0.1:8000',
    },
  },
  build: {
    rollupOptions: {
      output: { manualChunks: { live2d: ['pixi.js', 'pixi-live2d-display/cubism4'] } },
    },
  },
});
