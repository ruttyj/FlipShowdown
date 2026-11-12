import { signIn } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// E2: sign-in flows. A signed-out visitor is sent to /login and must land back where they
// started (the create request or the room link).

// --- Helpers -------------------------------------------------------------

/** Opens a new, signed-out browser context on this test's server. */
async function newVisitor(browser) {
    const context = await browser.newContext();
    const page = await context.newPage();
    return { context, page };
}

async function submitLoginForm(page, { name, email }) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Display name (optional)').fill(name);
    await page.getByRole('button', { name: 'Sign in' }).click();
}

// --- Tests ---------------------------------------------------------------

test('signed-out Create Room goes through login and creates exactly one room', async ({ browser }) => {
    const { page } = await newVisitor(browser);
    await page.goto('/');

    await page.getByRole('button', { name: 'Create Room' }).click();
    await expect(page).toHaveURL(/\/login/);

    await submitLoginForm(page, { name: 'Alice', email: 'alice@e2e.test' });

    await expect(page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    await expect(page.getByRole('button', { name: 'Start Game' })).toBeVisible();
    // The create request was consumed: Home no longer carries it.
    expect(page.url()).not.toContain('create=');
});

test('pressing Back twice after that creates no second room', async ({ browser }) => {
    const { page } = await newVisitor(browser);
    const createRequests = [];
    page.on('request', (request) => {
        const isCreate = request.method() === 'POST' && new URL(request.url()).pathname === '/api/rooms';
        if (isCreate) {
            createRequests.push(request.url());
        }
    });

    await page.goto('/');
    await page.getByRole('button', { name: 'Create Room' }).click();
    await submitLoginForm(page, { name: 'Alice', email: 'alice@e2e.test' });
    await expect(page).toHaveURL(/\/room\/[A-Z0-9]+$/);

    await page.goBack();
    await page.goBack();
    // Give a stray create request time to be sent before judging.
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);

    expect(createRequests).toHaveLength(1);
});

test('a room link opened signed out logs in and auto-joins under the account name', async ({ browser }) => {
    const host = await newVisitor(browser);
    await signIn(host.page, { name: 'Hosty', email: 'hosty@e2e.test' });
    await host.page.getByRole('button', { name: 'Create Room' }).click();
    await expect(host.page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    const roomUrl = new URL(host.page.url());

    const guest = await newVisitor(browser);
    await guest.page.goto(`${roomUrl.pathname}${roomUrl.search}`);
    await expect(guest.page).toHaveURL(/\/login/);

    await submitLoginForm(guest.page, { name: 'Gwen', email: 'gwen@e2e.test' });

    await expect(guest.page.getByRole('button', { name: 'Leave Room' })).toBeVisible();
    await expect(guest.page.getByText('Join Game')).toBeHidden();
    await expect(host.page.getByText('2 joined')).toBeVisible();
    await expect(host.page.getByText('Gwen').first()).toBeVisible();
});

// The "npm run share" HTTPS tunnel half of this case can't run in CI, so only the
// dev/served origin is covered above.
// struck: tunnel origin check (needs a public HTTPS tunnel).
