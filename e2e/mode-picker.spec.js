import { newPlayer } from './fixtures/players.js';
import { expect, test } from './fixtures/server.js';

// The mode picker's hover lift, which needs real layout and a real pointer.

const CARD_LIFT_PX = 4;
const CURRENT_CARD_RING_PX = 2;
const SETTLE_SAMPLES = 8;
const SAMPLE_GAP_MS = 60;

test.skip(({ isMobile }) => isMobile, 'Phones have no hover');

// --- Helpers -------------------------------------------------------------

async function openPicker(browser) {
    const player = await newPlayer(browser, 'Ada');
    await player.page.getByRole('button', { name: /^Game mode:/ }).click();

    const list = player.page.getByRole('radiogroup', { name: 'Game mode' });
    const radio = list.getByRole('radio', { name: 'Classic' });
    const card = radio.locator('..');
    await expect(radio).toBeFocused();
    await player.page.waitForTimeout(600); // The cards' entrance has to end before measuring them.

    return { page: player.page, list, card, restBox: await card.boundingBox() };
}

async function expectCardLifted(card, restBox) {
    await expect.poll(async () => (await card.boundingBox()).y).toBeCloseTo(restBox.y - CARD_LIFT_PX, 0);
}

// --- Hover ---------------------------------------------------------------

test('a hovered card keeps its whole ring inside the scrolling list', async ({ browser }) => {
    const { page, list, card, restBox } = await openPicker(browser);

    await page.mouse.move(restBox.x + restBox.width / 2, restBox.y + restBox.height / 2);
    await expectCardLifted(card, restBox);

    const listBox = await list.boundingBox();
    const cardBox = await card.boundingBox();
    expect(cardBox.y - CURRENT_CARD_RING_PX).toBeGreaterThanOrEqual(listBox.y);
});

test('a pointer on a card\'s bottom edge leaves it lifted, without flicker', async ({ browser }) => {
    const { page, card, restBox } = await openPicker(browser);

    await page.mouse.move(restBox.x + restBox.width / 2, restBox.y + restBox.height - 1);
    await expectCardLifted(card, restBox);

    // A browser only re-checks what's under a pointer that moves, so it slides along the edge.
    for (let sample = 0; sample < SETTLE_SAMPLES; sample += 1) {
        await page.mouse.move(restBox.x + restBox.width / 2 + sample, restBox.y + restBox.height - 1);
        await page.waitForTimeout(SAMPLE_GAP_MS);
        expect((await card.boundingBox()).y).toBeCloseTo(restBox.y - CARD_LIFT_PX, 0);
    }
});
