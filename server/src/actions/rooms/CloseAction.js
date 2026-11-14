// POST /api/rooms/:roomId/actions/close: the host closes the room, in any status.

export class CloseAction {
    name = 'close';
    access = 'host';
    allowedStatuses = null;

    constructor({ roomService }) {
        this.roomService = roomService;
    }

    handle(work) {
        this.roomService.close(work);
    }
}
