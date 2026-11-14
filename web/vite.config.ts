import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Интерфейс должен работать в Chrome 75 (ТЗ, п. 3.5): esbuild понижает синтаксис
// (?. ?? и т. п.) до уровня Chrome 75, CSS тоже собирается под эту версию.
export default defineConfig({
  plugins: [react()],
  build: {
    target: ['chrome75'],
    cssTarget: ['chrome75'],
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:8080' },
  },
});
