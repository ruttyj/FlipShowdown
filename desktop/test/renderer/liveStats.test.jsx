import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import LauncherApp from '../../src/renderer/LauncherApp.jsx';
import { createFakeLauncher, TUNNEL_URL } from './fakeLauncher.jsx';

// The live counts, the Rooms panel and its QR dialog (X66).

const HOSTING = { status: 'hosting', port: 7007, url: TUNNEL_URL };

function makeRoom(code, overrides = {}) {
    return { code, status: 'playing', round: 4, maxScore: 200, online: 2, players: 3, ...overrides };
}

function makeStats(rooms = [], playersOnline = rooms.reduce((sum, room) => sum + room.online, 0)) {
    return { playersOnline, roomsLive: rooms.length, rooms };
}

function manyRooms(count) {
    return Array.from({ length: count }, (_, index) => makeRoom(`ROOM${String(index).padStart(2, '0')}`, { online: 1 }));
}

async function renderLauncher(options) {
    const fake = createFakeLauncher(options);
    const user = userEvent.setup();
    const view = render(<LauncherApp launcher={fake.launcher} />);
    await screen.findByText(/^Server: /);
    // Let the first getRoomStats() answer land.
    await act(async () => {});
    return { fake, user, view };
}

function tile(label) {
    return screen.getByText(label).closest('.launcher-stat');
}

function roomsPanel() {
    return screen.getByRole('region', { name: 'Rooms' });
}

function roomCodes() {
    return within(roomsPanel()).getAllByRole('button', { name: /^Copy room code / })
        .map((button) => button.getAttribute('aria-label').replace('Copy room code ', ''));
}

afterEach(() => {
    vi.useRealTimers();
});

// --- Counts ----------------------------------------------------------------------------------

describe('the live counts', () => {
    test('show players online and rooms in play while hosting', async () => {
        await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6', { online: 3 })]) });

        expect(tile('Players online')).toHaveTextContent('3');
        expect(tile('Room in play')).toHaveTextContent('1');
        expect(tile('Players online')).toHaveAttribute('data-zero', 'false');
    });

    test('follow each push', async () => {
        const { fake } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats() });

        fake.emitRoomStats(makeStats([makeRoom('FW6XK6', { online: 1 })]));

        expect(tile('Player online')).toHaveTextContent('1');
    });

    test('at zero both tiles are grey and the host is told nobody has joined', async () => {
        await renderLauncher({ snapshot: HOSTING, roomStats: makeStats() });

        expect(tile('Players online')).toHaveAttribute('data-zero', 'true');
        expect(tile('Rooms in play')).toHaveAttribute('data-zero', 'true');
        expect(screen.getByText("Nobody's joined yet. Share the QR code below.")).toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Rooms' })).not.toBeInTheDocument();
    });

    test('show 0 / 0 while the tunnel connects, without the nobody-yet line or rooms', async () => {
        await renderLauncher({ snapshot: { status: 'starting-tunnel', port: 7007 }, roomStats: makeStats() });

        expect(tile('Players online')).toHaveTextContent('0');
        expect(screen.queryByText(/Nobody's joined yet/)).not.toBeInTheDocument();
    });

    test('dim, with the rooms, while the tunnel restarts', async () => {
        await renderLauncher({
            snapshot: { status: 'tunnel-restarting', port: 7007 },
            roomStats: makeStats([makeRoom('FW6XK6')]),
        });

        expect(tile('Players online').parentElement).toHaveAttribute('data-stale', 'true');
        expect(roomsPanel()).toHaveAttribute('data-stale', 'true');
    });

    test('are hidden while idle, and once a stop clears them', async () => {
        const { fake } = await renderLauncher({ roomStats: makeStats([makeRoom('FW6XK6')]) });
        expect(screen.queryByText('Players online')).not.toBeInTheDocument();

        fake.emitState(HOSTING);
        expect(tile('Players online')).toBeInTheDocument();

        fake.emitRoomStats(null);
        fake.emitState({ status: 'stopping', url: null });
        expect(screen.queryByText('Players online')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Rooms' })).not.toBeInTheDocument();
    });

    test('a push that lands before the first read answers is kept', async () => {
        const fake = createFakeLauncher({ snapshot: HOSTING });
        let answerRead;
        fake.launcher.getRoomStats.mockReturnValue(new Promise((resolve) => {
            answerRead = resolve;
        }));
        render(<LauncherApp launcher={fake.launcher} />);
        await screen.findByText(/^Server: /);

        fake.emitRoomStats(makeStats([makeRoom('FW6XK6', { online: 4 })]));
        await act(async () => answerRead(makeStats()));

        expect(tile('Players online')).toHaveTextContent('4');
    });

    test('a failed first read waits for the next push', async () => {
        const fake = createFakeLauncher({ snapshot: HOSTING });
        fake.launcher.getRoomStats.mockRejectedValue(new Error('IPC channel closed'));
        render(<LauncherApp launcher={fake.launcher} />);
        await screen.findByText(/^Server: /);
        await act(async () => {});
        expect(screen.queryByText('Players online')).not.toBeInTheDocument();

        fake.emitRoomStats(makeStats());

        expect(tile('Players online')).toBeInTheDocument();
    });
});

// --- Rooms panel -----------------------------------------------------------------------------

describe('the Rooms panel', () => {
    test('lists each room in play with its stage and who is online', async () => {
        await renderLauncher({
            snapshot: HOSTING,
            roomStats: makeStats([
                makeRoom('FW6XK6'),
                makeRoom('QP2M9A', { status: 'waiting', online: 1, players: 4 }),
                makeRoom('ZZ81TR', { status: 'finished', maxScore: 100, online: 1, players: 1 }),
            ]),
        });

        const panel = roomsPanel();
        expect(panel).toHaveTextContent('3 in play');
        expect(roomCodes()).toEqual(['FW6XK6', 'QP2M9A', 'ZZ81TR']);
        expect(within(panel).getByText('Round 4 · to 200')).toBeInTheDocument();
        expect(within(panel).getByText('In the lobby')).toBeInTheDocument();
        expect(within(panel).getByText('Game over · to 100')).toBeInTheDocument();
        expect(within(panel).getByText('1 of 4 online')).toBeInTheDocument();
    });

    test('comes after the game link', async () => {
        await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });

        const gameLink = screen.getByRole('region', { name: 'Join the game' });
        expect(gameLink.compareDocumentPosition(roomsPanel()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    test('clicking a room code copies it and says so for two seconds', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const fake = createFakeLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(<LauncherApp launcher={fake.launcher} />);
        const codeButton = await screen.findByRole('button', { name: 'Copy room code FW6XK6' });

        await user.click(codeButton);

        expect(await navigator.clipboard.readText()).toBe('FW6XK6');
        expect(codeButton).toHaveTextContent('Copied');
        expect(screen.getByText('Room code FW6XK6 copied.')).toHaveAttribute('role', 'status');

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(codeButton).toHaveTextContent('FW6XK6');
    });

    test('a copy the clipboard refuses says so', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
        const codeButton = screen.getByRole('button', { name: 'Copy room code FW6XK6' });

        await user.click(codeButton);

        expect(codeButton).toHaveTextContent("Couldn't copy");
        expect(screen.getByText("Couldn't copy room code FW6XK6.")).toBeInTheDocument();
    });

    test('shows five rooms, then Show all expands and Show fewer collapses', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats(manyRooms(7)) });
        expect(roomCodes()).toHaveLength(5);
        expect(screen.queryByRole('textbox', { name: 'Filter rooms by code' })).not.toBeInTheDocument();

        const showAll = screen.getByRole('button', { name: 'Show all 7 rooms' });
        expect(showAll).toHaveAttribute('aria-expanded', 'false');
        await user.click(showAll);

        expect(roomCodes()).toHaveLength(7);
        await user.click(screen.getByRole('button', { name: 'Show fewer' }));
        expect(roomCodes()).toHaveLength(5);
    });

    test('a few rooms have no Show all button', async () => {
        await renderLauncher({ snapshot: HOSTING, roomStats: makeStats(manyRooms(5)) });

        expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
    });

    test('past ten rooms the expanded list can be filtered by code, and collapsing clears it', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats(manyRooms(12)) });
        await user.click(screen.getByRole('button', { name: 'Show all 12 rooms' }));

        const filter = screen.getByRole('textbox', { name: 'Filter rooms by code' });
        await user.type(filter, 'room1');
        expect(roomCodes()).toEqual(['ROOM10', 'ROOM11']);

        await user.clear(filter);
        await user.type(filter, 'xyz');
        expect(screen.getByText('No room code contains "xyz".')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Show fewer' }));
        await user.click(screen.getByRole('button', { name: 'Show all 12 rooms' }));
        expect(screen.getByRole('textbox', { name: 'Filter rooms by code' })).toHaveValue('');
        expect(roomCodes()).toHaveLength(12);
    });

    test('rows hold still while the pointer is over the list', async () => {
        const { fake, user } = await renderLauncher({
            snapshot: HOSTING,
            roomStats: makeStats([makeRoom('AAAAAA', { online: 3 }), makeRoom('BBBBBB', { online: 1 })]),
        });

        await user.hover(within(roomsPanel()).getByRole('list'));
        fake.emitRoomStats(makeStats([makeRoom('BBBBBB', { online: 4 }), makeRoom('AAAAAA', { online: 3 })]));
        expect(roomCodes()).toEqual(['AAAAAA', 'BBBBBB']);

        await user.unhover(within(roomsPanel()).getByRole('list'));
        expect(roomCodes()).toEqual(['BBBBBB', 'AAAAAA']);
    });
});

// --- QR dialog -------------------------------------------------------------------------------

describe('the room QR dialog', () => {
    test('shows the room code and a QR code for its join link, and Escape returns focus', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });
        const qrButton = screen.getByRole('button', { name: 'Show QR code for room FW6XK6' });

        await user.click(qrButton);

        const dialog = screen.getByRole('dialog', { name: 'Join room FW6XK6' });
        expect(dialog).toHaveTextContent('Round 4 · to 200 · 2 of 3 online');
        expect(await within(dialog).findByRole('img', { name: 'QR code to join room FW6XK6' })).toBeInTheDocument();

        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(qrButton).toHaveFocus();
    });

    test('copies the code and the join link', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });
        await user.click(screen.getByRole('button', { name: 'Show QR code for room FW6XK6' }));
        const dialog = screen.getByRole('dialog');

        await user.click(within(dialog).getByRole('button', { name: 'Copy code' }));
        expect(await navigator.clipboard.readText()).toBe('FW6XK6');
        expect(dialog).toHaveTextContent('Room code copied.');

        await user.click(within(dialog).getByRole('button', { name: 'Copy join link' }));
        expect(await navigator.clipboard.readText()).toBe(`${TUNNEL_URL}/room/FW6XK6`);
        expect(dialog).toHaveTextContent('Join link copied.');
    });

    test('a refused copy in the dialog says so', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });
        await user.click(screen.getByRole('button', { name: 'Show QR code for room FW6XK6' }));
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

        await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Copy join link' }));

        expect(screen.getByRole('dialog')).toHaveTextContent("Couldn't copy the join link.");
    });

    test('stays open with a note when nobody in the room is online any more', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING, roomStats: makeStats([makeRoom('FW6XK6')]) });
        await user.click(screen.getByRole('button', { name: 'Show QR code for room FW6XK6' }));

        fake.emitRoomStats(makeStats());

        expect(screen.getByRole('dialog', { name: 'Join room FW6XK6' }))
            .toHaveTextContent('No one is online in this room right now. The code still works.');
    });

    test('the QR button is disabled while there is no game link', async () => {
        await renderLauncher({
            snapshot: { status: 'tunnel-restarting', port: 7007 },
            roomStats: makeStats([makeRoom('FW6XK6')]),
        });

        const qrButton = screen.getByRole('button', { name: 'Show QR code for room FW6XK6' });
        expect(qrButton).toBeDisabled();
        expect(qrButton).toHaveAttribute('title', 'The QR code needs the game link');
    });
});

// --- Power hint ------------------------------------------------------------------------------

describe('the power hint while hosting', () => {
    test('says the launcher keeps the computer awake', async () => {
        await renderLauncher({ snapshot: HOSTING });

        expect(screen.getByText(/Flip Showdown keeps this computer awake while hosting\./)).toBeInTheDocument();
        expect(screen.queryByText('Keep the lid open and the laptop plugged in while people play.')).not.toBeInTheDocument();
    });
});
