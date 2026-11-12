import { newPlayer } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// --- Smoke ---------------------------------------------------------------

test('a signed-in player creates a room and sees its code on the room page', async ({ browser }) => {
    const { page } = await newPlayer(browser, 'Alice');

    await page.getByRole('button', { name: 'Create Room' }).click();

    await expect(page).toHaveURL(/\/room\/[A-Z0-9]+$/);
    const code = new URL(page.url()).pathname.split('/').pop();
    await expect(page.getByText(code, { exact: true })).toBeVisible();
});
