import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// HUB_PORT / WEB_PORT 与 scripts/dev.mjs 共用，避免代理与 server 端静默分裂。
const hubPort = process.env.HUB_PORT ?? '7878';
const webPort = Number(process.env.WEB_PORT ?? '5173');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: webPort,
    proxy: {
      '/api': { target: `http://127.0.0.1:${hubPort}`, changeOrigin: true }
    }
  }
});
