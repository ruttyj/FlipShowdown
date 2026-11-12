import { newPlayer } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// Recovery after the connection, the server or the session goes away mid-game.
// Every test plays Alice (host) and Bob in separate contexts.

// The socket only notices a dead network on its next ping (every 10 s) plus the pong
// timeout (5 s), and the banner waits another 2 s before showing.
const SOCKET_LOSS_TIMEOUT_MS = 25_000;

// --- Clicking ------------------------------------------------------------

/**
 * Clicks `locator` once it is visible and enabled.
 *
 * Under parallel load WebKit can stop running requestAnimationFrame on a page for up to
 * ~15 s while it stays visible and focused (no screencast frames either). Playwright's
 * "stable" check needs two animation frames, so a plain click() times out although the
 * button is there. A forced click skips that check and still reaches the app, so WebKit
 * clicks are forced; the other browsers keep the full actionability checks.
 */
async function tap(locator) {
    await expect(locator).toBeVisible();
    await expect(locator).toBeEnabled();

    const browserName = locator.page().context().browser().browserType().name();
    await locator.click({ force: browserName === 'webkit' });
}

// --- Builders ------------------------------------------------------------

/** The scoreboard's round badge, e.g. "Round 2". */
function roundBadge(page, roundNumber) {
    return page.getByText(`Round ${roundNumber}`, { exact: true });
}

function scoreboardRow(page, playerName) {
    return page.getByRole('row').filter({ hasText: playerName });
}

function reconnectingBanner(page) {
    return page.getByRole('status').filter({ hasText: 'Reconnecting…' });
}

function signedOutButton(page) {
    return page.getByRole('button', { name: 'Signed out — tap to continue' });
}

function confirmDialog(page) {
    return page.getByRole('alertdialog');
}

/**
 * Signs Alice and Bob in, has Alice create a room, Bob join it by its link and Alice start
 * the game. Resolves with { alice, bob, roomPath } once both pages show round 1.
 */
async function startTwoPlayerGame(browser) {
    const alice = await newPlayer(browser, 'Alice');
    const bob = await newPlayer(browser, 'Bob');

    await tap(alice.page.getByRole('button', { name: 'Create Room' }));
    await expect(alice.page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    const roomUrl = new URL(alice.page.url());
    const roomPath = `${roomUrl.pathname}${roomUrl.search}`;

    // Opening the room's link joins a signed-in player straight away.
    await bob.page.goto(roomPath);
    await expect(bob.page.getByRole('button', { name: 'Leave Room' })).toBeVisible();

    await tap(alice.page.getByRole('button', { name: 'Start Game' }));
    await expect(roundBadge(alice.page, 1)).toBeVisible();
    await expect(roundBadge(bob.page, 1)).toBeVisible();

    return { alice, bob, roomPath };
}

// --- Actions -------------------------------------------------------------

async function forceNextRound(hostPage) {
    await tap(hostPage.getByRole('button', { name: 'Force Next Round' }));
    await tap(confirmDialog(hostPage).getByRole('button', { name: 'Force Next Round' }));
}

/** Opens manual entry and types one number card. */
async function enterNumberCard(page, value) {
    await tap(page.getByRole('button', { name: 'Enter Score Manually' }));
    await page.getByLabel('Card 1 value').fill(String(value));
}

/**
 * Fakes the tab being hidden or shown: browsers only change visibility for real when the
 * window is minimised or another tab is in front, which a headless run can't do.
 */
async function setTabVisibility(page, visibilityState) {
    await page.evaluate((state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    }, visibilityState);
}

function isRoomLookup(request) {
    return request.method() === 'GET' && request.url().includes('/api/rooms/by-code/');
}

// --- Network loss --------------------------------------------------------

test('an offline player catches up without a reload once back online, and the banner clears', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', "WebKit's setOffline leaves open WebSockets working, so the player never really goes offline");
    const { alice, bob } = await startTwoPlayerGame(browser);

    await bob.context.setOffline(true);
    await expect(reconnectingBanner(bob.page)).toBeVisible({ timeout: SOCKET_LOSS_TIMEOUT_MS });

    await forceNextRound(alice.page);
    await expect(roundBadge(alice.page, 2)).toBeVisible();

    await bob.context.setOffline(false);
    await expect(roundBadge(bob.page, 2)).toBeVisible();
    await expect(reconnectingBanner(bob.page)).toBeHidden();
});

test('a score submitted while offline shows an error, keeps the cards, and a retry succeeds', async ({ browser }) => {
    const { bob } = await startTwoPlayerGame(browser);
    await enterNumberCard(bob.page, 7);

    await bob.context.setOffline(true);
    await tap(bob.page.getByRole('button', { name: 'Confirm Score' }));

    await expect(bob.page.getByText(/^Submit score failed/)).toBeVisible();
    await expect(bob.page.getByLabel('Card 1 value')).toHaveValue('7');

    await bob.context.setOffline(false);
    await tap(bob.page.getByRole('button', { name: 'Confirm Score' }));
    await expect(bob.page.getByText(/^Score submitted/)).toBeVisible();
});

// --- Server restart ------------------------------------------------------

test('after a server restart mid-round every page reconnects and the round carries on', async ({ browser, server }) => {
    const { alice, bob } = await startTwoPlayerGame(browser);

    await server.restart();

    // Bob's score reaching Alice's page proves her socket is live again.
    await enterNumberCard(bob.page, 9);
    await tap(bob.page.getByRole('button', { name: 'Confirm Score' }));
    await expect(bob.page.getByText(/^Score submitted/)).toBeVisible();
    await expect(scoreboardRow(alice.page, 'Bob')).toContainText('9');

    // And the round closing on Alice's submit reaching Bob proves his is.
    await enterNumberCard(alice.page, 3);
    await tap(alice.page.getByRole('button', { name: 'Confirm Score' }));
    await expect(roundBadge(alice.page, 2)).toBeVisible();
    await expect(roundBadge(bob.page, 2)).toBeVisible();
    await expect(reconnectingBanner(alice.page)).toBeHidden();
    await expect(reconnectingBanner(bob.page)).toBeHidden();
});

// --- Hidden tab ----------------------------------------------------------

test('a tab that was hidden refetches the room when it is shown again', async ({ browser }) => {
    const { alice, bob } = await startTwoPlayerGame(browser);

    await setTabVisibility(bob.page, 'hidden');
    await forceNextRound(alice.page);
    await expect(roundBadge(alice.page, 2)).toBeVisible();

    const refetch = bob.page.waitForRequest(isRoomLookup);
    await setTabVisibility(bob.page, 'visible');
    await refetch;
    await expect(roundBadge(bob.page, 2)).toBeVisible();
});

// --- Session loss --------------------------------------------------------

// The reload after "tap to continue" can reset a WebSocket upgrade the server rejected with
// 401; that used to crash the server (X14), so this case also guards it.
test('a cleared session cookie shows the signed-out banner, whose link signs in and returns to the room', async ({ browser }) => {
    const { bob, roomPath } = await startTwoPlayerGame(browser);

    await bob.context.clearCookies();
    // Showing the tab again refetches the room, which now answers 401.
    await setTabVisibility(bob.page, 'hidden');
    await setTabVisibility(bob.page, 'visible');
    await expect(signedOutButton(bob.page)).toBeVisible();

    await tap(signedOutButton(bob.page));
    await expect(bob.page).toHaveURL(/\/login\?/);
    await bob.page.getByLabel('Email').fill(bob.email);
    await bob.page.getByLabel('Display name (optional)').fill(bob.name);
    await tap(bob.page.getByRole('button', { name: 'Sign in' }));

    await expect(bob.page).toHaveURL(roomPath);
    await expect(roundBadge(bob.page, 1)).toBeVisible();
    await expect(bob.page.getByRole('button', { name: 'Enter Score Manually' })).toBeVisible();
});

// --- Late score ----------------------------------------------------------

test('a score entered for a round that has since moved on shows the round-moved prompt', async ({ browser }) => {
    const { alice, bob } = await startTwoPlayerGame(browser);
    await enterNumberCard(bob.page, 4);

    await forceNextRound(alice.page);
    await expect(roundBadge(bob.page, 2)).toBeVisible();

    await tap(bob.page.getByRole('button', { name: 'Confirm Score' }));

    const prompt = confirmDialog(bob.page);
    await expect(prompt.getByText('The round moved on')).toBeVisible();
    await expect(prompt.getByText(/You entered this score for round 1, but the game is now on round 2/)).toBeVisible();
    await expect(prompt.getByRole('button', { name: 'Keep for now' })).toBeVisible();
});
