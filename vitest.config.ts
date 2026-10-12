import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

/**
 * Frontend tests only.
 *
 * Scoped to the Next.js side on purpose: `backend/` runs on the node built-in
 * test runner (`node --import tsx --test`), and its ~25 `.test.ts` files use
 * `node:test`'s `test()`/`assert`, not vitest's. An unscoped recursive include
 * would sweep them in and fail on the first import.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirrors tsconfig's `"@/*": ["./*"]`.
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    include: ['{app,features,shared,components}/**/*.test.{ts,tsx}'],
  },
})
