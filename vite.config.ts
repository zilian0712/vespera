import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'DEV_API_ORIGIN');
  const target = process.env.DEV_API_ORIGIN || env.DEV_API_ORIGIN || 'http://127.0.0.1:8787';
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target, ws: true, changeOrigin: true, headers: { Origin: target } },
      },
    },
  };
});
