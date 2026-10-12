import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  build: { outDir: process.env.VITE_STORAGE_MODE === 'browser' ? 'dist-pages' : 'dist', sourcemap: process.env.VITE_STORAGE_MODE !== 'browser' },
  server: { host: '127.0.0.1' },
});
