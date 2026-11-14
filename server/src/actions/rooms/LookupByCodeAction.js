import { ActionError } from '../../domain/errors.js';

// GET /api/rooms/by-code/:code for the join screen (RoomService#lookupByCode). Not a game action:
// it reads outside any transaction and writes nothing, so the runner doesn't run it and it isn't in
// the ActionRegistry. The rooms router calls it directly.

export class LookupByCodeAction {
    constructor({ roomService }) {
        this.roomService = roomService;
    }

    /**
     * Looks the room up for `user` (a users row). Returns { status, body } ready to send: 200 with
     * { room, players, my_player }, or an ActionError's status and body, such as a 404
     * `room_not_found`. Any other error is rethrown.
     */
    lookup(user, rawCode) {
        try {
            const body = this.roomService.lookupByCode(user.email, rawCode);
            return { status: 200, body };
        } catch (error) {
            if (error instanceof ActionError) {
                return { status: error.status, body: error.toBody() };
            }
            throw error;
        }
    }
}
