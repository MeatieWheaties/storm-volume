import { defineConfig } from 'vite';

// Relative base so the build works from a GitHub Pages project subpath.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
});
