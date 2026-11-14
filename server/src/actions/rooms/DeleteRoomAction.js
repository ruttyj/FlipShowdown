// POST /api/rooms/:roomId/actions/delete: the host deletes the room and everything in it, in any
// status (RoomService#deleteRoom).

export class DeleteRoomAction {
    name = 'delete';
    access = 'host';
    allowedStatuses = null;

    constructor({ roomService }) {
        this.roomService = roomService;
    }

    handle(work) {
        this.roomService.deleteRoom(work);
    }
}
