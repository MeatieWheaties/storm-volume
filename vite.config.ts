import { defineConfig } from 'vite';

// Relative base so the build works from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  // three.js alone is ~500 kB minified; one chunk is fine for a single-page viewer.
  build: { target: 'es2022', chunkSizeWarningLimit: 700 },
});
