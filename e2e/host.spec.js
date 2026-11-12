import { newPlayer } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// E3: host flows (kick, Make Host, host offline, edit mode, Force Next Round).

const HOLD_MS = 3000;
const HOLD_MARGIN_MS = 1000;

// --- Builders ------------------------------------------------------------

function roundBadge(page, roundNumber) {
    return page.getByText(`Round ${roundNumber}`, { exact: true });
}

/**
 * The player's row in the Scoreboard, found by its "Total" column. The score editor's table
 * has rows for the same players and stays in the DOM while its exit animation plays, so an
 * unscoped row locator can match both.
 */
function scoreboardRow(page, playerName) {
    const scoreboard = page.getByRole('table').filter({
        has: page.getByRole('columnheader', { name: 'Total' }),
    });
    return scoreboard.getByRole('row').filter({ hasText: playerName });
}

function confirmDialog(page) {
    return page.getByRole('alertdialog');
}

// --- Actions -------------------------------------------------------------

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

async function createRoom(host) {
    await tap(host.page.getByRole('button', { name: 'Create Room' }));
    await expect(host.page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    const roomUrl = new URL(host.page.url());
    return `${roomUrl.pathname}${roomUrl.search}`;
}

async function joinByLink(player, roomPath) {
    await player.page.goto(roomPath);
    await expect(player.page.getByRole('button', { name: 'Leave Room' })).toBeVisible();
}

/** The host creates a room, the others join by its link. */
async function openLobby(host, others) {
    const roomPath = await createRoom(host);
    for (const other of others) {
        await joinByLink(other, roomPath);
    }
    await expect(host.page.getByText(`${others.length + 1} joined`)).toBeVisible();
}

async function startGame(everyone) {
    await tap(everyone[0].page.getByRole('button', { name: 'Start Game' }));
    for (const player of everyone) {
        await expect(roundBadge(player.page, 1)).toBeVisible();
    }
}

async function submitNumber(player, value) {
    const { page } = player;
    await tap(page.getByRole('button', { name: 'Enter Score Manually' }));
    await page.getByLabel('Card 1 value').fill(String(value));
    await tap(page.getByRole('button', { name: 'Confirm Score' }));
    await expect(page.getByRole('button', { name: 'Confirm Score' })).toBeHidden();
}

async function kick(hostPage, playerName) {
    await tap(hostPage.getByRole('button', { name: `Kick ${playerName}` }));
    await tap(confirmDialog(hostPage).getByRole('button', { name: 'Kick Player' }));
}

/** Presses and holds a "Hold to vote" button with the mouse, then lets go. */
async function holdVote(page, playerName) {
    const button = page.getByRole('button', { name: `Hold to vote for ${playerName}` });
    await button.scrollIntoViewIfNeeded();
    const box = await button.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(HOLD_MS + HOLD_MARGIN_MS);
    await page.mouse.up();
}

// --- Kick ----------------------------------------------------------------

test('a kicked player sees the notice and can rejoin, and the round stops waiting for them', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    const cy = await newPlayer(browser, 'Cy');
    await openLobby(host, [bea, cy]);
    await startGame([host, bea, cy]);

    await kick(host.page, 'Cy');

    await expect(cy.page.getByText('You were removed from the game')).toBeVisible();
    await expect(cy.page.getByRole('button', { name: 'Join Room' })).toBeVisible();

    // With only Hosty and Bea left, their two scores close the round.
    await submitNumber(host, 4);
    await submitNumber(bea, 6);
    await expect(roundBadge(host.page, 2)).toBeVisible();
    await expect(roundBadge(bea.page, 2)).toBeVisible();

    await tap(cy.page.getByRole('button', { name: 'Join Room' }));
    await expect(cy.page.getByRole('button', { name: 'Leave Game' })).toBeVisible();
});

test('a kicked player who reloads is not silently back in the room (X3)', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const cy = await newPlayer(browser, 'Cy');
    await openLobby(host, [cy]);
    await startGame([host, cy]);

    await kick(host.page, 'Cy');
    await expect(cy.page.getByRole('button', { name: 'Join Room' })).toBeVisible();

    await cy.page.reload();

    await expect(cy.page.getByRole('button', { name: 'Join Room' })).toBeVisible();
    await expect(cy.page.getByRole('button', { name: 'Leave Game' })).toBeHidden();

    // Rejoining by hand still works.
    await tap(cy.page.getByRole('button', { name: 'Join Room' }));
    await expect(cy.page.getByRole('button', { name: 'Leave Game' })).toBeVisible();
});

// --- Make Host -----------------------------------------------------------

test('Make Host moves the host controls to the new host', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await expect(bea.page.getByRole('button', { name: 'Start Game' })).toBeHidden();

    await tap(host.page.getByRole('button', { name: 'Make host', exact: true }));
    await tap(confirmDialog(host.page).getByRole('button', { name: 'Make Host' }));

    await expect(bea.page.getByRole('button', { name: 'Start Game' })).toBeVisible();
    await expect(host.page.getByRole('button', { name: 'Start Game' })).toBeHidden();
    await expect(host.page.getByRole('button', { name: 'Make host', exact: true })).toBeHidden();
    await expect(bea.page.getByRole('button', { name: 'Make host', exact: true })).toBeVisible();
});

// --- Host offline --------------------------------------------------------

test.describe('with a short host-offline grace', () => {
    // Long enough to see the countdown, short enough not to wait the real 2 minutes.
    test.use({ serverEnv: { HOST_OFFLINE_GRACE_SECONDS: '8' } });

    test('when the host goes offline the others hold to vote and a new host is chosen', async ({ browser, browserName }) => {
        test.skip(browserName === 'webkit', 'The 3 s mouse hold is too timing-sensitive on WebKit');
        test.setTimeout(120_000);
        const host = await newPlayer(browser, 'Hosty');
        const bea = await newPlayer(browser, 'Bea');
        const cy = await newPlayer(browser, 'Cy');
        await openLobby(host, [bea, cy]);
        await startGame([host, bea, cy]);
        await expect(bea.page.getByText('Vote for a new host')).toBeHidden();

        await host.context.close();

        await expect(bea.page.getByText(/opens in \d:\d\d/)).toBeVisible({ timeout: 30_000 });
        await expect(bea.page.getByRole('heading', { name: 'Choose a new host' })).toBeVisible({ timeout: 30_000 });
        await expect(cy.page.getByRole('heading', { name: 'Choose a new host' })).toBeVisible();

        // Everyone remaining holds the same candidate.
        await Promise.all([holdVote(bea.page, 'Bea'), holdVote(cy.page, 'Bea')]);

        await expect(bea.page.getByRole('button', { name: 'Force Next Round' })).toBeVisible();
        await expect(cy.page.getByRole('button', { name: 'Force Next Round' })).toBeHidden();
    });
});

// --- Edit mode -----------------------------------------------------------

test('the host edits an old round and the totals update everywhere', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);
    await submitNumber(host, 5);
    await submitNumber(bea, 7);
    await expect(roundBadge(bea.page, 2)).toBeVisible();

    await tap(host.page.getByRole('button', { name: 'Edit Scores' }));
    await expect(bea.page.getByText('Host is editing scores')).toBeVisible();

    await tap(host.page.getByRole('button', { name: 'Edit round 1 score for Bea' }));
    await host.page.getByLabel('Card 1 value').fill('20');
    await tap(host.page.getByRole('button', { name: 'Save', exact: true }));
    await tap(host.page.getByRole('button', { name: 'Done Editing' }));
    await expect(host.page.getByRole('button', { name: 'Done Editing' })).toBeHidden();
    await expect(bea.page.getByText('Host is editing scores')).toBeHidden();

    for (const player of [host, bea]) {
        await expect(scoreboardRow(player.page, 'Bea')).toContainText('20');
        await expect(scoreboardRow(player.page, 'Hosty')).toContainText('5');
    }
});

// --- Entering cards (X40) --------------------------------------------------

test('others are told to hold on while a player enters cards, until they submit', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    const cy = await newPlayer(browser, 'Cy');
    await openLobby(host, [bea, cy]);
    await startGame([host, bea, cy]);
    const holdOn = 'Hold on, Bea is entering cards';

    await tap(bea.page.getByRole('button', { name: 'Enter Score Manually' }));
    await expect(host.page.getByText(holdOn)).toBeVisible();
    await expect(cy.page.getByText(holdOn)).toBeVisible();
    await expect(bea.page.getByText(/Hold on/)).toHaveCount(0);

    await bea.page.getByLabel('Card 1 value').fill('5');
    await tap(bea.page.getByRole('button', { name: 'Confirm Score' }));
    await expect(host.page.getByText(holdOn)).toHaveCount(0);
    await expect(cy.page.getByText(holdOn)).toHaveCount(0);
});

// --- Game modes -------------------------------

function pageTheme(page) {
    return page.locator('html');
}

function logoPicker(page) {
    return page.getByRole('button', { name: /Change mode/ });
}

function modeNote(page, label) {
    return page.getByRole('note', { name: `Game mode: ${label}` });
}

async function expectTheme(players, mode) {
    for (const player of players) {
        await expect(pageTheme(player.page)).toHaveAttribute('data-game-mode', mode);
    }
}

/** Opens the host's dropdown and picks a mode. Once playing, the switch asks first. */
async function chooseMode(hostPage, label) {
    await tap(logoPicker(hostPage));
    await tap(hostPage.getByRole('radio', { name: label }));
}

async function chooseModeMidGame(hostPage, label) {
    await chooseMode(hostPage, label);
    await tap(confirmDialog(hostPage).getByRole('button', { name: 'Switch' }));
}

/** A lobby in Vengeance, with the shift over so the theme has settled on every screen. */
async function openVengeanceLobby(host, others) {
    await openLobby(host, others);
    await chooseMode(host.page, 'Vengeance');
    await expectTheme([host, ...others], 'vengeance');
    await expect(host.page.getByRole('button', { name: 'Start Vengeance Game' })).toBeVisible();
}

async function startVengeanceGame(everyone) {
    await tap(everyone[0].page.getByRole('button', { name: 'Start Vengeance Game' }));
    for (const player of everyone) {
        await expect(roundBadge(player.page, 1)).toBeVisible();
    }
}

async function createRoomWithMaxScore(host, maxScore) {
    await tap(host.page.getByRole('button', { name: 'Game settings' }));
    await host.page.getByLabel('Max Score (Game ends when reached)').fill(String(maxScore));
    return createRoom(host);
}

/** Bea joins a Vengeance room with a low target, so one score finishes the game. */
async function openShortVengeanceGame(host, bea, maxScore) {
    const roomPath = await createRoomWithMaxScore(host, maxScore);
    await joinByLink(bea, roomPath);
    await chooseMode(host.page, 'Vengeance');
    await expectTheme([host, bea], 'vengeance');
    await startVengeanceGame([host, bea]);
}

async function tapBust(player) {
    await tap(player.page.getByRole('button', { name: 'Bust', exact: true }));
}

/** A bust that leaves the round open, so the submitted panel shows. */
async function submitBust(player) {
    await tapBust(player);
    await expect(player.page.getByRole('button', { name: 'Undo bust' })).toBeVisible();
}

test('a mode switch reaches both players, re-scores an open entry, then locks at the first score', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await expectTheme([host, bea], 'classic');
    await expect(modeNote(bea.page, 'Classic')).toBeVisible();
    await expect(logoPicker(bea.page)).toHaveCount(0);

    await chooseMode(host.page, 'Vengeance');

    await expectTheme([host, bea], 'vengeance');
    await expect(bea.page.getByText('Host switched to Vengeance')).toBeVisible();
    await expect(host.page.getByText('Host switched to Vengeance')).toHaveCount(0);
    await expect(modeNote(bea.page, 'Vengeance')).toBeVisible();

    // The room code card takes the theme: Vengeance's plum (X41).
    const roomCard = host.page.locator('.room-code-card');
    await expect(roomCard).toHaveCSS('background-color', /rgb\(63, 26, 61\)/);

    await startVengeanceGame([host, bea]);

    // Stale entry: the host switches while Bea has a hand open, and her cards stay.
    await tap(bea.page.getByRole('button', { name: 'Enter Score Manually' }));
    await bea.page.getByLabel('Card 1 value').fill('11');
    await chooseModeMidGame(host.page, 'Classic');
    await expectTheme([host, bea], 'classic');
    await expect(bea.page.getByText(/Your cards were re-scored/)).toBeVisible();
    await expect(bea.page.getByLabel('Card 1 value')).toHaveValue('11');

    await tap(bea.page.getByRole('button', { name: 'Confirm Score' }));
    await expect(logoPicker(host.page)).toHaveCount(0);
    await expect(modeNote(host.page, 'Classic')).toBeVisible();

    // Refreshing mid-game comes back in the room's theme, with no toast.
    await bea.page.reload();
    await expect(roundBadge(bea.page, 1)).toBeVisible();
    await expectTheme([bea], 'classic');
    await expect(bea.page.getByText(/Host switched/)).toHaveCount(0);
});

test('a switch made while a player is offline reaches them when they reconnect', async ({ browser, browserName }) => {
    test.skip(browserName === 'webkit', "WebKit's setOffline leaves open WebSockets working");
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await expectTheme([bea], 'classic');

    await bea.context.setOffline(true);
    await expect(bea.page.getByRole('status').filter({ hasText: 'Reconnecting…' })).toBeVisible({ timeout: 25_000 });
    await chooseMode(host.page, 'Vengeance');
    await expectTheme([host], 'vengeance');
    await expectTheme([bea], 'classic');

    await bea.context.setOffline(false);

    await expectTheme([bea], 'vengeance');
    await expect(modeNote(bea.page, 'Vengeance')).toBeVisible();
});

test('a new host gets the mode picker and the old host loses it', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await expect(logoPicker(host.page)).toBeVisible();

    await tap(host.page.getByRole('button', { name: 'Make host', exact: true }));
    await tap(confirmDialog(host.page).getByRole('button', { name: 'Make Host' }));

    await expect(logoPicker(bea.page)).toBeVisible();
    await expect(logoPicker(host.page)).toHaveCount(0);

    await chooseMode(bea.page, 'Vengeance');
    await expectTheme([host, bea], 'vengeance');
    await expect(host.page.getByText('Host switched to Vengeance')).toBeVisible();
});

test('a guest can read the mode overlay and its rules, with nothing to select', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openVengeanceLobby(host, [bea]);

    await tap(bea.page.getByRole('button', { name: /See the modes$/ }));
    const overlay = bea.page.getByRole('dialog', { name: 'Game modes' });
    await expect(overlay.getByText('Only the host can change it.', { exact: false })).toBeVisible();
    await expect(overlay.getByRole('radio')).toHaveCount(0);

    await tap(overlay.getByRole('button', { name: 'Full rules for Brutal' }));
    await expect(bea.page.getByRole('tab', { name: /Brutal/ })).toHaveAttribute('aria-selected', 'true');
    await tap(bea.page.getByRole('button', { name: 'Close' }));
    await expect(overlay).toBeVisible();

    await expectTheme([host, bea], 'vengeance');
});

test('leaving a Vengeance room takes the theme off the page', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openVengeanceLobby(host, [bea]);

    await tap(bea.page.getByRole('button', { name: 'Leave Room' }));
    const confirmLeave = confirmDialog(bea.page).getByRole('button', { name: /Leave/ });
    if (await confirmLeave.count() > 0) {
        await tap(confirmLeave);
    }

    await expect(bea.page.getByRole('button', { name: 'Create Room' })).toBeVisible();
    await expect(pageTheme(bea.page)).not.toHaveAttribute('data-game-mode');
});

test('a kicked player sees the room\'s Join screen in its theme, and it goes on leaving the page', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    const roomPath = await createRoom(host);
    const code = roomPath.split('/').pop();
    // Joined from Home inside the app, so going back is a real route change and not a page load.
    await bea.page.getByPlaceholder('Enter room code').fill(code);
    await tap(bea.page.getByRole('button', { name: 'Join room' }));
    await expect(bea.page.getByRole('button', { name: 'Leave Room' })).toBeVisible();
    await chooseMode(host.page, 'Vengeance');
    await expectTheme([bea], 'vengeance');

    await kick(host.page, 'Bea');

    await expect(bea.page.getByRole('button', { name: 'Join Room' })).toBeVisible();
    await expectTheme([bea], 'vengeance');

    await bea.page.goBack();

    await expect(bea.page.getByRole('button', { name: 'Create Room' })).toBeVisible();
    await expect(pageTheme(bea.page)).not.toHaveAttribute('data-game-mode');
});

test('Play Again keeps the mode, and the host can switch again while waiting', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openShortVengeanceGame(host, bea, 10);
    await submitNumber(host, 12);
    await tapBust(bea);
    await expect(host.page.getByText('Game Over!')).toBeVisible();
    await expectTheme([host, bea], 'vengeance');

    await tap(host.page.getByRole('button', { name: 'Play Again' }));
    await tap(confirmDialog(host.page).getByRole('button', { name: 'Start New Game' }));

    await expect(host.page.getByRole('button', { name: 'Start Vengeance Game' })).toBeVisible();
    await expectTheme([host, bea], 'vengeance');

    await chooseMode(host.page, 'Classic');

    await expect(host.page.getByRole('button', { name: 'Start Game', exact: true })).toBeVisible();
    await expectTheme([host, bea], 'classic');
});

// --- Confirming a score (X47) ----------------------------------------------

test('entering a score on a short screen brings the turn card to the top', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);
    await bea.page.setViewportSize({ width: 360, height: 480 });

    await tap(bea.page.getByRole('button', { name: 'Enter Score Manually' }));
    await bea.page.getByLabel('Card 1 value').fill('6');

    // Scroll to the end first, so the turn card is off the top of the screen whatever opening the
    // entry did. dispatchEvent because a click could scroll again.
    const currentTurn = bea.page.getByRole('group', { name: 'Current Turn' });
    const nextUp = bea.page.getByRole('group', { name: 'Next Up' });
    const confirmScore = bea.page.getByRole('button', { name: 'Confirm Score' });
    await confirmScore.evaluate((button) => {
        const scroller = button.closest('.overflow-y-auto');
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
    });
    await expect(currentTurn).not.toBeInViewport();

    await confirmScore.dispatchEvent('click');

    await expect(bea.page.getByText('Score submitted: 6')).toBeAttached();
    await expect(currentTurn).toBeInViewport({ ratio: 1 });
    await expect(nextUp).toBeInViewport({ ratio: 1 });
    // The smooth scroll takes a moment. At the top, not merely on screen.
    await expect.poll(async () => (await currentTurn.boundingBox()).y).toBeLessThan(120);
});

// --- Correcting a score (X45) ----------------------------------------------

test('a player busts, undoes it on the panel and enters a score, and the stale toast is gone', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);

    await submitBust(bea);
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('BUST');
    const toastUndo = bea.page.getByRole('button', { name: 'Undo', exact: true });
    await expect(toastUndo).toBeVisible();

    await tap(bea.page.getByRole('button', { name: 'Undo bust' }));

    await expect(bea.page.getByRole('button', { name: 'Bust', exact: true })).toBeVisible();
    await expect(toastUndo).toHaveCount(0);
    await expect(scoreboardRow(host.page, 'Bea')).not.toContainText('BUST');

    await submitNumber(bea, 6);
    await expect(bea.page.getByText('Score submitted: 6')).toBeVisible();
    await submitNumber(host, 4);

    for (const player of [host, bea]) {
        await expect(roundBadge(player.page, 2)).toBeVisible();
        await expect(scoreboardRow(player.page, 'Bea')).toContainText('6');
        await expect(scoreboardRow(player.page, 'Bea')).not.toContainText('BUST');
    }
});

test('Undo on the bust toast goes back to the three tiles', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);
    await submitBust(bea);

    await tap(bea.page.getByRole('button', { name: 'Undo', exact: true }));

    await expect(bea.page.getByRole('button', { name: 'Bust', exact: true })).toBeVisible();
    await expect(bea.page.getByRole('button', { name: 'Undo bust' })).toHaveCount(0);
    await expect(scoreboardRow(host.page, 'Bea')).not.toContainText('BUST');
});

test('Change score reopens entry with the stored cards, and the new score replaces the old', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);
    await submitNumber(bea, 5);
    await expect(bea.page.getByText('Score submitted: 5')).toBeVisible();

    await tap(bea.page.getByRole('button', { name: 'Change score' }));

    await expect(bea.page.getByLabel('Card 1 value')).toHaveValue('5');
    await bea.page.getByLabel('Card 1 value').fill('8');
    await tap(bea.page.getByRole('button', { name: 'Confirm Score' }));

    await expect(bea.page.getByText('Score submitted: 8')).toBeVisible();
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('8');
});

test('a bust in a closed round shows as BUST, and the host turns it into a score in the editor', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);
    await submitBust(bea);
    await submitNumber(host, 4);
    await expect(roundBadge(bea.page, 2)).toBeVisible();
    await expect(scoreboardRow(bea.page, 'Bea')).toContainText('BUST');

    await tap(host.page.getByRole('button', { name: 'Edit Scores' }));
    await tap(host.page.getByRole('button', { name: /Edit round 1 score for Bea/ }));
    await tap(host.page.getByRole('switch', { name: 'Bust' }));
    await host.page.getByLabel('Card 1 value').fill('9');
    await tap(host.page.getByRole('button', { name: 'Save', exact: true }));
    await tap(host.page.getByRole('button', { name: 'Done Editing' }));

    for (const player of [host, bea]) {
        await expect(scoreboardRow(player.page, 'Bea')).toContainText('9');
        await expect(scoreboardRow(player.page, 'Bea')).not.toContainText('BUST');
    }
});

test('the Steal or Swap override saves a duplicate as a score, not a bust', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openVengeanceLobby(host, [bea]);
    await startVengeanceGame([host, bea]);
    const { page } = bea;

    await tap(page.getByRole('button', { name: 'Enter Score Manually' }));
    await page.getByLabel('Card 1 value').fill('5');
    await tap(page.getByRole('button', { name: 'Add card' }));
    await page.getByLabel('Card 2 value').fill('5');
    await expect(page.getByText('Duplicate Cards')).toBeVisible();

    await tap(page.getByRole('switch', { name: 'Came from a Steal or Swap' }));

    await expect(page.getByText('Duplicate Cards')).toHaveCount(0);
    await tap(page.getByRole('button', { name: 'Confirm Score' }));
    await expect(page.getByText('Score submitted: 10')).toBeVisible();
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('10');
    await expect(scoreboardRow(host.page, 'Bea')).not.toContainText('BUST');
});

test('the host reopens a finished game: the mode stands, guests are told, and the game carries on', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openShortVengeanceGame(host, bea, 10);
    await submitNumber(host, 12);
    await tapBust(bea);
    await expect(bea.page.getByText('Game Over!')).toBeVisible();
    await expect(bea.page.getByRole('button', { name: 'Reopen Game' })).toHaveCount(0);

    await tap(host.page.getByRole('button', { name: 'Reopen Game' }));
    await tap(confirmDialog(host.page).getByRole('button', { name: 'Reopen Game' }));

    await expect(bea.page.getByText('Host reopened the game')).toBeVisible();
    await expect(bea.page.getByText('Host is editing scores')).toBeVisible();
    await expect(bea.page.getByText(/Host switched/)).toHaveCount(0);
    await expect(host.page.getByTestId('mode-shift')).toHaveCount(0);
    await expectTheme([host, bea], 'vengeance');
    await expect(modeNote(host.page, 'Vengeance')).toBeVisible();

    await tap(host.page.getByRole('button', { name: 'Edit round 1 score for Hosty' }));
    await host.page.getByLabel('Card 1 value').fill('4');
    await tap(host.page.getByRole('button', { name: 'Save', exact: true }));
    await tap(host.page.getByRole('button', { name: 'Done Editing' }));

    for (const player of [host, bea]) {
        await expect(roundBadge(player.page, 2)).toBeVisible();
        await expect(scoreboardRow(player.page, 'Hosty')).toContainText('4');
    }
});

// --- Brutal (X43) --------------------------------------------------------

/** A lobby in Brutal, with the shift over so the theme has settled on every screen. */
async function openBrutalGame(host, others) {
    await openLobby(host, others);
    await chooseMode(host.page, 'Brutal');
    await expectTheme([host, ...others], 'brutal');
    await tap(host.page.getByRole('button', { name: 'Start Brutal Game' }));
    for (const player of [host, ...others]) {
        await expect(roundBadge(player.page, 1)).toBeVisible();
    }
}

/** The labels of the bust panel's minus card buttons that a tap on some corner would miss. */
function coveredMinusCardButtons(page) {
    return page.evaluate(() => {
        const covered = [];
        for (const button of document.querySelectorAll('[aria-label^="Add −"]')) {
            const box = button.getBoundingClientRect();
            // Inset, because a point outside the rounded corner isn't part of the button.
            const inset = 4;
            const corners = [
                [box.left + inset, box.top + inset],
                [box.right - inset, box.top + inset],
                [box.left + inset, box.bottom - inset],
                [box.right - inset, box.bottom - inset],
            ];
            const isReachable = corners.every(([x, y]) => button.contains(document.elementFromPoint(x, y)));
            if (!isReachable) {
                covered.push(button.getAttribute('aria-label'));
            }
        }
        return covered;
    });
}

/** Opens manual entry and types seven different numbers, summing to 28. */
async function enterFlipSeven(player) {
    const { page } = player;
    await tap(page.getByRole('button', { name: 'Enter Score Manually' }));
    for (let value = 1; value <= 7; value += 1) {
        await page.getByLabel(`Card ${value} value`).fill(String(value));
        if (value < 7) {
            await tap(page.getByRole('button', { name: 'Add card' }));
        }
    }
}

test('Brutal: a Flip 7 takes 15 from a rival, who is told, and taking it back returns it', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openBrutalGame(host, [bea]);

    await enterFlipSeven(bea);
    await expect(bea.page.getByRole('radio', { name: 'Keep the +15' })).toBeChecked();
    await expect(bea.page.getByText('43', { exact: true })).toBeVisible();
    await tap(bea.page.getByRole('radio', { name: '−15 from Hosty' }));
    await expect(bea.page.getByText('28', { exact: true })).toBeVisible();
    await tap(bea.page.getByRole('button', { name: 'Confirm Score' }));

    await expect(bea.page.getByText('Score submitted: 28')).toBeVisible();
    await expect(host.page.getByText('Bea flipped 7 and took 15 points from you')).toBeVisible();
    for (const player of [host, bea]) {
        await expect(scoreboardRow(player.page, 'Hosty')).toContainText('−15 from Bea');
        await expect(scoreboardRow(player.page, 'Hosty')).toContainText('-15');
    }

    // Change score brings the hand and the choice back, and leaving the score out returns the 15.
    await tap(bea.page.getByRole('button', { name: 'Change score' }));
    await expect(bea.page.getByRole('radio', { name: '−15 from Hosty' })).toBeChecked();
    await expect(scoreboardRow(host.page, 'Hosty')).not.toContainText('−15 from Bea');
    await expect(scoreboardRow(host.page, 'Hosty')).not.toContainText('-15');
});

test('Brutal: a −15 keeps a player under the target, so the game carries on', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    const roomPath = await createRoomWithMaxScore(host, 20);
    await joinByLink(bea, roomPath);
    await chooseMode(host.page, 'Brutal');
    await expectTheme([host, bea], 'brutal');
    await tap(host.page.getByRole('button', { name: 'Start Brutal Game' }));
    await expect(roundBadge(bea.page, 1)).toBeVisible();

    await submitNumber(host, 25);
    await enterFlipSeven(bea);
    await tap(bea.page.getByRole('button', { name: 'Add card' }));
    await tap(bea.page.getByRole('button', { name: 'Minus', exact: true }));
    await bea.page.getByLabel('Card 8 value').fill('10');
    await tap(bea.page.getByRole('radio', { name: '−15 from Hosty' }));
    await tap(bea.page.getByRole('button', { name: 'Confirm Score' }));

    // Bea's hand is 18, and Hosty is back to 10, so nobody has reached 20.
    for (const player of [host, bea]) {
        await expect(roundBadge(player.page, 2)).toBeVisible();
        await expect(scoreboardRow(player.page, 'Hosty')).toContainText('−15 from Bea');
    }
    await expect(host.page.getByText('Game Over!')).toHaveCount(0);
});

test('Brutal: a busted player adds minus cards and the table shows BUST with the score', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openBrutalGame(host, [bea]);

    await tap(bea.page.getByRole('button', { name: 'Bust', exact: true }));
    await tap(bea.page.getByRole('button', { name: 'Confirm Bust' }));
    await expect(bea.page.getByRole('button', { name: 'Undo bust' })).toBeVisible();
    await expect(bea.page.getByText('Score so far: 0')).toBeVisible();

    await tap(bea.page.getByRole('button', { name: 'Add −6' }));
    await expect(bea.page.getByText('Score so far: −6')).toBeVisible();
    await tap(bea.page.getByRole('button', { name: 'Add −2' }));
    await expect(bea.page.getByText('Score so far: −8')).toBeVisible();

    await expect(scoreboardRow(host.page, 'Bea')).toContainText('BUST');
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('−8');
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('-8');
    await expect(bea.page.getByRole('button', { name: 'Undo bust' })).toBeVisible();
});

test('Brutal: the last player to bust gets their minus cards in before the round closes', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openBrutalGame(host, [bea]);
    await submitNumber(host, 5);

    await tap(bea.page.getByRole('button', { name: 'Bust', exact: true }));
    await tap(bea.page.getByRole('button', { name: 'Add −6' }));
    await tap(bea.page.getByRole('button', { name: 'Add −2' }));
    await expect(bea.page.getByText('Score so far: −8')).toBeVisible();
    await tap(bea.page.getByRole('button', { name: 'Confirm Bust' }));

    await expect(roundBadge(host.page, 2)).toBeVisible();
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('BUST');
    await expect(scoreboardRow(host.page, 'Bea')).toContainText('-8');
});

test.describe('on a short 360 px phone', () => {
    test.use({ viewport: { width: 360, height: 640 } });

    test('Brutal: busting brings the minus cards clear of the floating buttons', async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium-desktop', 'The phone projects have their own fixed viewports.');

        const host = await newPlayer(browser, 'Hosty');
        const bea = await newPlayer(browser, 'Bea');
        await openBrutalGame(host, [bea]);
        const { page } = bea;

        await tap(page.getByRole('button', { name: 'Bust', exact: true }));
        await expect(page.getByText('Score so far: 0')).toBeVisible();
        await expect.poll(() => coveredMinusCardButtons(page)).toEqual([]);
        await tap(page.getByRole('button', { name: 'Confirm Bust' }));
        await expect(page.getByRole('button', { name: 'Undo bust' })).toBeVisible();

        // A tap on a covered edge would fire the quick send on top, so every corner has to be clear.
        // That is why this bust doesn't go to the turn card (X47): there, Add −2 is covered. Any
        // scroll has settled once the panel has held the top for a moment.
        const panelTop = async () => (await page.getByRole('paragraph').filter({ hasText: 'You busted this round' }).boundingBox()).y;
        await expect.poll(panelTop).toBeLessThan(120);
        await page.waitForTimeout(700);
        expect(await panelTop()).toBeLessThan(120);
        expect(await coveredMinusCardButtons(page)).toEqual([]);
    });

    test('a Classic bust brings the turn card to the top', async ({ browser }, testInfo) => {
        test.skip(testInfo.project.name !== 'chromium-desktop', 'The phone projects have their own fixed viewports.');

        const host = await newPlayer(browser, 'Hosty');
        const bea = await newPlayer(browser, 'Bea');
        await openLobby(host, [bea]);
        await startGame([host, bea]);
        const { page } = bea;
        await page.setViewportSize({ width: 360, height: 400 });

        const bust = page.getByRole('button', { name: 'Bust', exact: true });
        await bust.scrollIntoViewIfNeeded();
        const currentTurn = page.getByRole('group', { name: 'Current Turn' });
        await expect(currentTurn).not.toBeInViewport();
        await tap(bust);

        await expect(page.getByRole('button', { name: 'Undo bust' })).toBeAttached();
        await expect(currentTurn).toBeInViewport({ ratio: 1 });
        await expect(page.getByRole('group', { name: 'Next Up' })).toBeInViewport({ ratio: 1 });
    });
});

test('Brutal: "Came from a Steal or Swap" undoes a duplicate bust', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openBrutalGame(host, [bea]);
    const { page } = bea;

    await tap(page.getByRole('button', { name: 'Enter Score Manually' }));
    await page.getByLabel('Card 1 value').fill('5');
    await tap(page.getByRole('button', { name: 'Add card' }));
    await page.getByLabel('Card 2 value').fill('5');
    await expect(page.getByText('Duplicate Cards')).toBeVisible();

    await tap(page.getByRole('switch', { name: 'Came from a Steal or Swap' }));

    await expect(page.getByText('Duplicate Cards')).toHaveCount(0);
    await tap(page.getByRole('button', { name: 'Confirm Score' }));
    await expect(page.getByText('Score submitted: 10')).toBeVisible();
});

test('Brutal: the mood shifts in and out of it, and the logo names the mode', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);

    for (const [label, mode] of [['Brutal', 'brutal'], ['Vengeance', 'vengeance'], ['Brutal', 'brutal'], ['Classic', 'classic']]) {
        await chooseMode(host.page, label);
        await expectTheme([host, bea], mode);
        await expect(modeNote(bea.page, label)).toBeVisible();
        await expect(host.page.getByTestId('mode-shift')).toHaveCount(0);
    }
    await chooseMode(host.page, 'Brutal');
    await expectTheme([host, bea], 'brutal');
    await expect(bea.page.getByText('Host switched to Brutal').last()).toBeVisible();
    await expect(bea.page.getByText('Brutal', { exact: true }).first()).toBeVisible();

    await bea.page.reload();
    await expect(pageTheme(bea.page)).toHaveAttribute('data-game-mode', 'brutal');
});

// --- Force Next Round ----------------------------------------------------

test('Force Next Round zero-scores the players who have not submitted', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    await openLobby(host, [bea]);
    await startGame([host, bea]);
    await submitNumber(host, 8);

    await tap(host.page.getByRole('button', { name: 'Force Next Round' }));
    await tap(confirmDialog(host.page).getByRole('button', { name: 'Force Next Round' }));

    for (const player of [host, bea]) {
        await expect(roundBadge(player.page, 2)).toBeVisible();
        await expect(scoreboardRow(player.page, 'Bea')).toContainText('0');
        await expect(scoreboardRow(player.page, 'Hosty')).toContainText('8');
    }
});
