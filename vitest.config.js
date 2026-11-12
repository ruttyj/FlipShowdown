import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config.js'

// Vitest runs the React hook and component tests (tests/ui/) and the desktop launcher's UI
// tests (desktop/test/renderer/). It reuses vite.config.js so the "@/" alias and the React
// plugin behave exactly as in the app. The pure-logic tests in tests/*.test.js and
// desktop/test/*.test.js belong to `node --test` and are deliberately not included here.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['tests/ui/**/*.test.jsx', 'desktop/test/renderer/**/*.test.jsx'],
      // Undo vi.stubGlobal / vi.spyOn changes after every test so they can't leak.
      unstubGlobals: true,
      restoreMocks: true,
      setupFiles: ['tests/ui/setup.js'],
      coverage: {
        provider: 'v8',
        // Report every source file, tested or not, so the totals are honest.
        all: true,
        include: ['src/**/*.{js,jsx}', 'shared/**/*.js', 'desktop/src/renderer/**/*.{js,jsx}'],
        // shadcn copies, generated helpers and the entry point aren't ours to test.
        // Keep in step with scripts/lcov/areas.mjs, which merges
        // this report with the node one and enforces the per-area targets.
        exclude: [
          'src/components/ui/**',
          'src/lib/utils.js',
          'src/hooks/use-mobile.jsx',
          'src/utils/**',
          'src/types/**',
          'src/main.jsx',
          'desktop/src/renderer/main.jsx',
        ],
        reporter: ['text-summary', 'lcov'],
        reportsDirectory: 'coverage/ui',
      },
    },
  }),
)
