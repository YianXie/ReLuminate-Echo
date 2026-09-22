import { defineConfig } from 'vitest/config'

// Served from the root of a custom domain (play.reluminate-global.org), so base is '/'.
// If you fork this to a project-page URL, set base to '/<repo-name>/'.
export default defineConfig({
  base: '/',
  build: { target: 'es2022', outDir: 'dist' },
  // Plain Node, no jsdom: everything under test is pure logic that never touches the DOM
  // or an AudioContext. `vite build` ignores this block.
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
})
