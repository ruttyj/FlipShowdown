// POST /api/rooms/:roomId/actions/start: the host starts the first game (RoomService#start).

export class StartAction {
    name = 'start';
    access = 'host';
    allowedStatuses = ['waiting'];

    constructor({ roomService }) {
        this.roomService = roomService;
    }

    handle(work) {
        this.roomService.start(work);
    }
}
