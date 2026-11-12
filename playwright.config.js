import { defineConfig, devices } from '@playwright/test';

// Browser end-to-end tests. Each test starts its own real
// server through the `server` fixture in e2e/fixtures/server.js, so there is no `webServer`
// here. The frontend is built once by the global setup.
//
// Run: npx playwright test --reporter=line
//      npx playwright test --project=chromium-desktop e2e/smoke.spec.js
export default defineConfig({
    testDir: 'e2e',
    globalSetup: './e2e/fixtures/build-frontend.js',
    // A test can start, restart and stop a server and drive several players.
    timeout: 60_000,
    expect: { timeout: 10_000 },
    fullyParallel: true,
    // Each test runs its own server and several browser contexts. Under heavier parallel load
    // WebKit stops painting frames for seconds, so Playwright's stability checks time out.
    workers: 4,
    forbidOnly: Boolean(process.env.CI),
    retries: process.env.CI ? 1 : 0,
    reporter: 'line',
    use: {
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        actionTimeout: 10_000,
        navigationTimeout: 15_000,
    },
    projects: [
        {
            name: 'chromium-desktop',
            use: { ...devices['Desktop Chrome'] },
        },
        {
            name: 'pixel-7',
            use: { ...devices['Pixel 7'] },
        },
        {
            name: 'iphone-14',
            use: { ...devices['iPhone 14'] },
        },
    ],
});
