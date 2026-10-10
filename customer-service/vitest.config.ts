import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { standardDecoratorPlugin } from '../vitest.shared.ts'

// The plugin sources are plain JavaScript outside the pnpm workspace, so they
// cannot resolve `@deepseek-ai/dsh-*` at runtime (ADR-0006). Tests are a
// different plane: they run through Vite, so the repository's tsconfig `paths`
// facade resolves workspace packages to `src` exactly as every in-tree lane
// does, and the repository's decorator pre-transform runs for the same reason
// it does in the in-tree lanes — several harness packages declare their remote
// services with standard decorators, which neither Vite's parser nor Node
// executes untransformed. The include stays inside this directory, so a run
// here never picks up repository suites.
export default defineConfig({
  // Pinned to this directory: Vitest would otherwise treat the invoking cwd as
  // the root, and the relative `projects` path below would resolve from there.
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [tsconfigPaths({ projects: ['../tsconfig.base.json'] }), standardDecoratorPlugin()],
  test: {
    include: ['tests/**/*.spec.ts'],
    testTimeout: 30_000,
  },
})
