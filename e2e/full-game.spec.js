import { newPlayer } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// E1: a whole game with a host and two players, each in their own browser context.
// Max score is 30 so the game ends in three rounds.

const MAX_SCORE = '30';

// --- Helpers -------------------------------------------------------------

async function createRoomWithMaxScore(page, maxScore) {
    const createButton = page.getByRole('button', { name: 'Create Room' });
    await page.getByRole('button', { name: 'Game settings' }).click();
    await page.getByLabel('Max Score (Game ends when reached)').fill(maxScore);
    await createButton.click();

    await expect(page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    return new URL(page.url()).pathname.split('/').pop();
}

async function joinByCode(player, code) {
    const { page } = player;

    // A signed-in player joins under the account name, so there is no Join screen.
    await page.getByPlaceholder('Enter room code').fill(code);
    await page.getByRole('button', { name: 'Join room' }).click();

    await expect(page.getByRole('button', { name: 'Leave Room' })).toBeVisible();
}

/** Adds one row per card; the editor starts with a single empty number row. */
async function fillCards(page, cards) {
    for (let index = 0; index < cards.length; index++) {
        const position = index + 1;
        if (index > 0) {
            await page.getByRole('button', { name: 'Add card' }).click();
        }
        await page.getByLabel(`Card ${position} type`).selectOption(cards[index].type);
        await page.getByLabel(`Card ${position} value`).fill(cards[index].value);
    }
}

async function submitManualScore(player, cards) {
    const { page } = player;

    await page.getByRole('button', { name: 'Enter Score Manually' }).click();
    await fillCards(page, cards);
    await page.getByRole('button', { name: 'Confirm Score' }).click();
}

/** The Bust tile busts without asking (its toast and panel offer Undo). */
async function submitBust(player) {
    await player.page.getByRole('button', { name: 'Bust', exact: true }).click();
}

function numbers(...values) {
    return values.map((value) => ({ type: 'number', value: String(value) }));
}

async function expectRoundOnEveryScreen(players, round) {
    for (const player of players) {
        await expect(player.page.getByText(`Round ${round}`, { exact: true })).toBeVisible();
    }
}

// --- Test ----------------------------------------------------------------

test('a three-player game runs from join to winner and Play Again, with no reloads', async ({ browser }) => {
    const host = await newPlayer(browser, 'Hosty');
    const bea = await newPlayer(browser, 'Bea');
    const cy = await newPlayer(browser, 'Cy');
    const everyone = [host, bea, cy];

    // Lobby: join by code, reorder, start.
    const code = await createRoomWithMaxScore(host.page, MAX_SCORE);
    await joinByCode(bea, code);
    await joinByCode(cy, code);
    for (const player of everyone) {
        await expect(player.page.getByText('3 joined')).toBeVisible();
    }

    await host.page.getByRole('button', { name: 'Make Cy go first' }).click();
    await expect(host.page.getByText('First', { exact: true })).toBeVisible();

    await host.page.getByRole('button', { name: 'Start Game' }).click();
    await expectRoundOnEveryScreen(everyone, 1);

    // Round 1: manual entry, a bust, and a hand below zero (X1).
    await submitManualScore(host, numbers(9));
    await submitBust(bea);
    await submitManualScore(cy, numbers(-3));
    await expectRoundOnEveryScreen(everyone, 2);
    for (const player of everyone) {
        await expect(player.page.getByText('-3').first()).toBeVisible();
    }

    // Round 2: Hosty 9 + 12 = 21, Bea 14, Cy busts.
    await submitManualScore(host, numbers(5, 7));
    await submitManualScore(bea, numbers(14));
    await submitBust(cy);
    await expectRoundOnEveryScreen(everyone, 3);

    // Round 3: Bea reaches 31, Hosty stops at 29.
    await submitManualScore(host, numbers(8));
    await submitManualScore(bea, numbers(17));
    await submitBust(cy);

    for (const player of everyone) {
        await expect(player.page.getByText('Game Over!')).toBeVisible();
        await expect(player.page.getByText('Bea wins!')).toBeVisible();
    }

    // Play Again: back in the lobby with the same three players, then a fresh round 1.
    await host.page.getByRole('button', { name: 'Play Again' }).click();
    await host.page.getByRole('button', { name: 'Start New Game' }).click();

    for (const player of everyone) {
        await expect(player.page.getByText('3 joined')).toBeVisible();
        for (const name of ['Hosty', 'Bea', 'Cy']) {
            await expect(player.page.getByText(name).first()).toBeVisible();
        }
    }

    await host.page.getByRole('button', { name: 'Start Game' }).click();
    await expectRoundOnEveryScreen(everyone, 1);
    for (const player of everyone) {
        await expect(player.page.getByText('Game Over!')).toBeHidden();
    }
});
