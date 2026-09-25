import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Off by default; `npm run test:coverage` turns it on. No thresholds yet:
    // this records the baseline, and a floor comes once it's known.
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
    },
  },
})
