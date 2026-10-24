import { defineConfig } from 'vite';

// `npm run dev` serves the site with hot reload and forwards /api (including room
// WebSockets) to `wrangler dev` on :8787.
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: true,
    proxy: { '/api': { target: 'http://localhost:8787', ws: true } },
  },
});
