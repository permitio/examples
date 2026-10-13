import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'src/web',
  plugins: [react(), tailwindcss()],
  // `@/` is the web source root.
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src/web') } },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    // Third-party code in its own chunk keeps each chunk under Vite's 500 kB warning.
    rollupOptions: {
      output: { manualChunks: (id) => (id.includes('/node_modules/') ? 'vendor' : undefined) },
    },
  },
  // '/api/' with the slash: a bare '/api' prefix would also send the UI's own module /api.ts to the
  // backend.
  server: { proxy: { '/api/': 'http://localhost:3000' } },
});
