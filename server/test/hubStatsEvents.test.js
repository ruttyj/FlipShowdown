import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { openStore } from '../src/database/db.js';
import { STATS_CHANGED } from '../src/managers/roomStats.js';
import { createRealtimeHub } from '../src/realtime/hub.js';
import { silentLogger } from './helpers.js';

// The hub's statsChanged notification (X66), which the launcher reporter listens for: a GameRoom
// change emits it, and the createRealtimeHub `onStatsChanged` option listens for it. Presence
// changes emit it too; launcherStats.test covers those end to end.

describe('hub stats notification', () => {
    let dataDir;
    let store;
    let hub;
    let optionCalls;
    let eventCalls;

    beforeEach(() => {
        dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-test-'));
        store = openStore(dataDir);
        optionCalls = 0;
        eventCalls = 0;
        hub = createRealtimeHub({
            authenticate: () => null,
            store,
            logger: silentLogger,
            onStatsChanged: () => {
                optionCalls += 1;
            },
        });
        hub.statsEvents.on(STATS_CHANGED, () => {
            eventCalls += 1;
        });
    });

    afterEach(() => {
        hub.close();
        store.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
    });

    test('a published GameRoom change emits it once, to the option and to statsEvents', () => {
        const [room] = store.createRecords('GameRoom', [{ status: 'waiting' }], null);

        hub.publishAll([
            { entity: 'GameRoom', type: 'update', record: room },
            { entity: 'GameRoom', type: 'update', record: room },
        ]);

        assert.equal(optionCalls, 1);
        assert.equal(eventCalls, 1);
    });

    test('a change to anything else does not', () => {
        const [room] = store.createRecords('GameRoom', [{ status: 'waiting' }], null);
        const [player] = store.createRecords('Player', [{ room_id: room.id, email: 'ann@example.com' }], null);

        hub.publish('Player', 'update', player);

        assert.equal(optionCalls, 0);
        assert.equal(eventCalls, 0);
    });
});
