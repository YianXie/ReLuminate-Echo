import { defineConfig } from 'vite'

// Served from the root of a custom domain (play.reluminate-global.org), so base is '/'.
// If you fork this to a project-page URL, set base to '/<repo-name>/'.
export default defineConfig({
  base: '/',
  build: { target: 'es2022', outDir: 'dist' },
})
