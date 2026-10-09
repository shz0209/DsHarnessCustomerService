import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// The plugin sources are plain JavaScript outside the pnpm workspace, so they
// cannot resolve `@deepseek-ai/dsh-*` at runtime (ADR-0006). Tests are a
// different plane: they run through Vite, so the repository's tsconfig `paths`
// facade resolves workspace packages to `src` exactly as every in-tree lane
// does. The include stays inside this directory, so a run here never picks up
// repository suites.
export default defineConfig({
  // Pinned to this directory: Vitest would otherwise treat the invoking cwd as
  // the root, and the relative `projects` path below would resolve from there.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tsconfigPaths({ projects: ['../tsconfig.base.json'] })],
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
