import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each suite boots a fresh PGlite instance and applies the full schema —
    // ~25 tables plus RLS policies, grants and SECURITY DEFINER functions.
    // That is comfortably past vitest's 10s default on a cold WASM start.
    hookTimeout: 60_000,
    testTimeout: 30_000,
    // PGlite is a single in-process connection per suite. Running files in
    // parallel is fine (separate instances), but keep concurrency modest so
    // several WASM Postgres instances do not thrash a laptop.
    maxConcurrency: 2,
  },
})
