import { CLIENT_MESSAGE } from '../../../../shared/realtimeProtocol.js';

/**
 * entry-status: the socket's player is scanning, typing or (null) done entering their cards.
 * Message { room_id, state, round }.
 */
export class EntryStatusHandler {
    type = CLIENT_MESSAGE.ENTRY_STATUS;
    #entries;

    /** `entries` is the EntryStatusManager. */
    constructor({ entries }) {
        this.#entries = entries;
    }

    handle(socket, message) {
        this.#entries.receive(socket, message);
    }
}
