import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openStore } from '../src/database/db.js';
import { createRealtimeHub } from '../src/realtime/hub.js';
import { silentLogger } from './helpers.js';

// The hub's stats notification (X66), which the launcher reporter subscribes to through
// hub.onStatsChanged: a GameRoom change calls the listeners. Presence changes call them too;
// launcherStats.test covers those end to end.

describe('hub stats notification', () => {
    let dataDir;
    let store;
    let hub;
    let calls;
    let stopListening;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-test-'));
        store = openStore(dataDir);
        calls = 0;
        hub = createRealtimeHub({
            authenticate: () => null,
            store,
            logger: silentLogger,
        });
        stopListening = hub.onStatsChanged(() => {
            calls += 1;
        });
    });

    afterEach(() => {
        hub.close();
        store.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('a published GameRoom change calls the listener once', () => {
        const [room] = store.createRecords('GameRoom', [{ status: 'waiting' }], null);

        hub.publishAll([
            { entity: 'GameRoom', type: 'update', record: room },
            { entity: 'GameRoom', type: 'update', record: room },
        ]);

        assert.equal(calls, 1);
    });

    test('a change to anything else does not', () => {
        const [room] = store.createRecords('GameRoom', [{ status: 'waiting' }], null);
        const [player] = store.createRecords('Player', [{ room_id: room.id, email: 'ann@example.com' }], null);

        hub.publish('Player', 'update', player);

        assert.equal(calls, 0);
    });

    test('the returned function stops the listener', () => {
        const [room] = store.createRecords('GameRoom', [{ status: 'waiting' }], null);

        stopListening();
        hub.publish('GameRoom', 'update', room);

        assert.equal(calls, 0);
    });
});
