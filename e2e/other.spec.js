import { newPlayer } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// Duplicate tabs, chat emoji and the 360 px layout.

const NARROW_WIDTH = 360;

// --- Helpers -------------------------------------------------------------

async function createRoom(page) {
    await page.getByRole('button', { name: 'Create Room' }).click();
    await expect(page).toHaveURL(/\/room\/[A-Z0-9]+$/);

    const url = new URL(page.url());
    return { code: url.pathname.split('/').pop(), path: `${url.pathname}${url.search}` };
}

/** Opening the room's link joins a signed-in player straight away. */
async function joinByLink(player, roomPath) {
    await player.page.goto(roomPath);
    await expect(player.page.getByRole('button', { name: 'Leave Room' })).toBeVisible();
}

/** The settings gear next to Create Room is an icon-only button, found as its sibling. */
async function createRoomWithMaxScore(page, maxScore) {
    const createButton = page.getByRole('button', { name: 'Create Room' });
    await createButton.locator('xpath=following-sibling::button').click();
    await page.getByLabel('Max Score (Game ends when reached)').fill(maxScore);
    await createButton.click();

    await expect(page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    const url = new URL(page.url());
    return `${url.pathname}${url.search}`;
}

async function startGame(host) {
    await host.page.getByRole('button', { name: 'Start Game' }).click();
    await expect(host.page.getByText('Round 1', { exact: true })).toBeVisible();
}

async function submitNumbers(player, values) {
    const { page } = player;

    await page.getByRole('button', { name: 'Enter Score Manually' }).click();
    for (let index = 0; index < values.length; index++) {
        const position = index + 1;
        if (index > 0) {
            await page.getByRole('button', { name: 'Add card' }).click();
        }
        await page.getByLabel(`Card ${position} type`).selectOption('number');
        await page.getByLabel(`Card ${position} value`).fill(String(values[index]));
    }
    await page.getByRole('button', { name: 'Confirm Score' }).click();
}

/** The Bust tile busts without asking (its toast and panel offer Undo). */
async function submitBust(player) {
    await player.page.getByRole('button', { name: 'Bust', exact: true }).click();
}

async function expectNoHorizontalScroll(page) {
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth).toBeLessThanOrEqual(NARROW_WIDTH);
}

/** Sends the grinning-face emoji with a message to the default recipient (the other player). */
async function sendGrinningFace(player, message) {
    // A double tap opens the chat dialog (X79).
    await player.page.getByRole('button', { name: 'Chat', exact: true }).dblclick();
    // After a first send the picker lists the emoji again under "Frequently Used" (and the
    // suggested row), so the button appears several times. Those copies sit under a sticky
    // category label that intercepts the click; the last one is in the main Smileys list.
    await player.page.getByRole('button', { name: 'grinning face', exact: true }).last().click();
    await player.page.getByPlaceholder('Type a message...').fill(message);
    await player.page.getByRole('button', { name: 'Send', exact: true }).click();
}

// A full-size emoji dismisses itself after 3 s (X35), which a slow CI machine can use up on the
// sender's clicks alone. This stretches that one timer on the player's next page load, for tests
// about what the overlay shows while it is up.
async function keepFullEmojiOnScreen(player) {
    await player.page.addInitScript(() => {
        const realSetTimeout = window.setTimeout;
        window.setTimeout = (callback, delay, ...args) => (
            realSetTimeout(callback, delay === 3000 ? 120_000 : delay, ...args)
        );
    });
}

// --- Duplicate tab -------------------------------------------------------

test('two tabs of the same player in one room show the duplicate-tab notice', async ({ browser }) => {
    const alice = await newPlayer(browser, 'Alice');
    const room = await createRoom(alice.page);
    const notice = 'This room is open in another tab. Close one to avoid double actions.';

    await expect(alice.page.getByText(notice)).toBeHidden();

    // A second tab in the same context shares the browser's BroadcastChannel.
    const secondTab = await alice.context.newPage();
    await secondTab.goto(room.path);

    await expect(secondTab.getByText(notice)).toBeVisible();
    await expect(alice.page.getByText(notice)).toBeVisible();
});

// --- Chat ----------------------------------------------------------------

test('a chat emoji appears on the other player\'s screen', async ({ browser }) => {
    const alice = await newPlayer(browser, 'Alice');
    const bob = await newPlayer(browser, 'Bob');
    const room = await createRoom(alice.page);
    await joinByLink(bob, room.path);
    await startGame(alice);
    await expect(bob.page.getByText('Round 1', { exact: true })).toBeVisible();

    // A double tap opens the chat dialog (X79); with two players Bob is Alice's default recipient.
    await alice.page.getByRole('button', { name: 'Chat', exact: true }).dblclick();
    await alice.page.getByRole('button', { name: 'grinning face', exact: true }).click();
    await alice.page.getByPlaceholder('Type a message...').fill('hello Bob');
    await alice.page.getByRole('button', { name: 'Send', exact: true }).click();

    // The sender sees the small version, labelled with who it went to. Checked first, as it
    // fades out after a few seconds.
    await expect(alice.page.getByRole('status').filter({ hasText: 'You → Bob' })).toBeVisible();

    const overlay = bob.page.getByRole('dialog', { name: 'Message from Alice' });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByText('hello Bob')).toBeVisible();
    await expect(overlay.getByText('😀')).toBeVisible();
    await expect(overlay.getByText('Alice → You')).toBeVisible();
});

// --- Chat mute (X44) -----------------------------------------------------

/** The computed animation of the pulse ring, which only a real browser's CSS can answer. */
function readRingAnimation(ring) {
    return ring.evaluate((element) => {
        const style = getComputedStyle(element);
        return { duration: style.animationDuration, iterations: style.animationIterationCount };
    });
}

test('muting chat holds back messages for me and pulses; unmuting replays nothing', async ({ browser }) => {
    const alice = await newPlayer(browser, 'Alice');
    const bob = await newPlayer(browser, 'Bob');
    const room = await createRoom(alice.page);
    await joinByLink(bob, room.path);
    await startGame(alice);
    await expect(bob.page.getByText('Round 1', { exact: true })).toBeVisible();
    const overlay = bob.page.getByRole('dialog', { name: 'Message from Alice' });
    const ring = bob.page.getByTestId('chat-mute-pulse');

    // Tapping mute while an item plays closes it.
    await sendGrinningFace(alice, 'before muting');
    await expect(overlay).toBeVisible();
    await bob.page.getByRole('button', { name: 'Mute chat' }).click();
    await expect(overlay).toBeHidden();

    await bob.page.getByRole('button', { name: 'Unmute chat' }).waitFor();
    const bobChatButton = bob.page.getByRole('button', { name: 'Chat', exact: true });
    await expect(bobChatButton).toBeHidden();

    await sendGrinningFace(alice, 'while muted');
    await expect(ring).toBeAttached();
    await expect(overlay).toBeHidden();
    expect(await readRingAnimation(ring)).toEqual({ duration: '2s', iterations: '3' });

    await bob.page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await readRingAnimation(ring)).toEqual({ duration: '4s', iterations: '1' });
    await expect(ring).not.toBeAttached({ timeout: 8000 });

    await bob.page.getByRole('button', { name: 'Unmute chat' }).click();
    await expect(bobChatButton).toBeVisible();
    await bob.page.reload();
    await expect(bob.page.getByRole('button', { name: 'Mute chat' })).toBeVisible();
    await expect(overlay).toBeHidden();

    await sendGrinningFace(alice, 'after unmuting');
    await expect(overlay.getByText('after unmuting')).toBeVisible();
});

test('the chat mute button shows in a game room but not on Home, and the sun toggle is gone', async ({ browser }) => {
    const alice = await newPlayer(browser, 'Alice');
    await expect(alice.page.getByRole('button', { name: 'Mute sounds' })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Mute chat' })).toBeHidden();

    await createRoom(alice.page);

    await expect(alice.page.getByRole('button', { name: 'Mute chat' })).toBeVisible();
    await expect(alice.page.getByRole('button', { name: 'Keep the screen on' })).toBeHidden();
});

// --- 360 px layout -------------------------------------------------------

test.describe('360 px wide', () => {
    test.use({ viewport: { width: NARROW_WIDTH, height: 740 } });

    test('Home, Waiting, Active and Finished do not scroll sideways', async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium-desktop', 'The phone projects have their own fixed viewports.');

        const host = await newPlayer(browser, 'Hosty');
        const bea = await newPlayer(browser, 'Bea');

        await expectNoHorizontalScroll(host.page);

        // Max score 30 so one round ends the game.
        const roomPath = await createRoomWithMaxScore(host.page, '30');
        await joinByLink(bea, roomPath);
        await expect(host.page.getByText('2 joined')).toBeVisible();
        await expectNoHorizontalScroll(host.page);

        await startGame(host);
        await expectNoHorizontalScroll(host.page);

        await submitNumbers(host, [12, 11, 10]);
        await submitBust(bea);
        await expect(host.page.getByText('Game Over!')).toBeVisible();
        await expectNoHorizontalScroll(host.page);
    });

    test('a stack of chat emoji clears with Dismiss all and stays on screen', async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium-desktop', 'The phone projects have their own fixed viewports.');

        const host = await newPlayer(browser, 'Hosty');
        const bea = await newPlayer(browser, 'Bea');
        const roomPath = await createRoom(host.page).then((room) => room.path);
        await keepFullEmojiOnScreen(bea);
        await joinByLink(bea, roomPath);
        await startGame(host);
        await expect(bea.page.getByText('Round 1', { exact: true })).toBeVisible();

        await sendGrinningFace(host, 'one');
        const overlay = bea.page.getByRole('dialog', { name: 'Message from Hosty' });
        await expect(overlay).toBeVisible();

        // Two sends in one update play only one (X31), so the second waits for the first overlay.
        await sendGrinningFace(host, 'two');
        await expect(overlay.getByText('1 more')).toBeVisible();

        const dismissAll = overlay.getByRole('button', { name: 'Dismiss all' });
        await expect(dismissAll).toBeVisible();

        // Taken after "1 more" is visible, so the entry spring animation has finished.
        const box = await dismissAll.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(NARROW_WIDTH);
        // The overlay is fixed, so this only guards the page itself, not the overlay.
        await expectNoHorizontalScroll(bea.page);

        await dismissAll.click();
        await expect(overlay).toBeHidden();
        await expect(bea.page.getByText('two', { exact: true })).toHaveCount(0);
    });
});

// --- Rules sheet ---------------------------------------------------------

test.describe('a short phone', () => {
    test.use({ viewport: { width: NARROW_WIDTH, height: 480 } });

    test('the rules sheet keeps Close and the tabs on screen while the rules scroll', async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium-desktop', 'The phone projects have their own fixed viewports.');

        const host = await newPlayer(browser, 'Hosty');
        await createRoom(host.page);
        await host.page.getByRole('button', { name: 'Rules' }).first().click();
        const sheet = host.page.getByRole('dialog', { name: 'Rules' });
        await expect(sheet).toBeVisible();

        // Whichever of the two is the scroller, go to the bottom of it.
        const scrolledTo = await sheet.evaluate((dialog) => {
            const panel = dialog.querySelector('[role="tabpanel"]:not([hidden])');
            dialog.scrollTop = dialog.scrollHeight;
            panel.scrollTop = panel.scrollHeight;
            return dialog.scrollTop + panel.scrollTop;
        });
        expect(scrolledTo).toBeGreaterThan(0);

        await expect(sheet.getByRole('button', { name: 'Close' })).toBeInViewport({ ratio: 1 });
        const tabs = sheet.getByRole('tablist');
        await expect(tabs).toBeInViewport({ ratio: 1 });

        await sheet.getByRole('tab', { name: 'Vengeance' }).click();
        await expect(sheet.getByRole('tab', { name: 'Vengeance' })).toHaveAttribute('aria-selected', 'true');
        await sheet.getByRole('button', { name: 'Close' }).click();
        await expect(sheet).toBeHidden();
    });
});
