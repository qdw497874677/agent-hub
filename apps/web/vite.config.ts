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
      // ws: 终端走 /api/sessions/:id/terminal（同源 WS），代理不转发 upgrade 就永远是「断线」
      '/api': { target: `http://127.0.0.1:${hubPort}`, changeOrigin: true, ws: true }
    }
  }
});
