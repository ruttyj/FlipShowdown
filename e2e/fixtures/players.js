// Signs players in through the dev /login form, each in their own browser context (so each
// has their own session cookie, like separate phones).
//
// Usage, inside a test that uses the `server` fixture from ./server.js:
//
//     import { test, expect } from './fixtures/server.js';
//     import { newPlayer } from './fixtures/players.js';
//
//     test('two players', async ({ browser }) => {
//         const alice = await newPlayer(browser, 'Alice');
//         const bob = await newPlayer(browser, 'Bob', { email: 'bob@test.local' });
//         await alice.page.getByRole('button', { name: 'Create Room' }).click();
//         ...
//     });
//
// newPlayer() returns { context, page, name, email } with `page` on Home, signed in.
// The context inherits the project's device and the test's baseURL; the test runner
// closes it when the test ends. The default email is "<name>@e2e.test" in lower case.

import { expect } from '@playwright/test';

function defaultEmail(name) {
    const localPart = name.toLowerCase().replace(/[^a-z0-9]+/g, '.');
    return `${localPart}@e2e.test`;
}

/** Fills in and submits the dev login form on `page`, then waits for Home. */
export async function signIn(page, { name, email }) {
    await page.goto('/login?from_url=/');
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Display name (optional)').fill(name);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('button', { name: 'Create Room' })).toBeVisible();
}

/**
 * Opens a new browser context and signs `name` in.
 * options: { email } to choose the email (defaults to one derived from the name).
 */
export async function newPlayer(browser, name, options = {}) {
    const email = options.email || defaultEmail(name);
    const context = await browser.newContext();
    const page = await context.newPage();

    await signIn(page, { name, email });
    return { context, page, name, email };
}
