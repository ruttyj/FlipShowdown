import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../../src/database/db.js';

// Shared setup for the actions/ unit tests (this file contains no tests of its own): a real store
// in a temp folder, and a seeded room.

export const HOST = { email: 'host@example.com' };
export const GUEST = { email: 'guest@example.com' };
export const OUTSIDER = { email: 'outsider@example.com' };

/** A fresh store in a temp folder. `close()` closes it and deletes the folder. */
export function openTempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-actions-'));
    const store = openStore(dir);

    return {
        store,
        close() {
            store.close();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}

/**
 * A `waiting` room hosted by HOST at version 3, with the guest seated before the host in turn
 * order (so turn order and joining order differ). Returns { room, host, guest }.
 */
export function seedRoom(store, roomFields = {}) {
    const [room] = store.createRecords(
        'GameRoom',
        [{ code: 'ABCDEF', status: 'waiting', host_email: HOST.email, max_score: 200, version: 3, ...roomFields }],
        HOST.email,
    );
    const [host, guest] = store.createRecords(
        'Player',
        [
            { room_id: room.id, email: HOST.email, name: 'Host', turn_order: 1, is_host: true },
            { room_id: room.id, email: GUEST.email, name: 'Guest', turn_order: 0, is_host: false },
        ],
        HOST.email,
    );
    return { room, host, guest };
}
