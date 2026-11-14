/** POST leave: removes the caller's Player. No body. */
export class LeaveAction {
    name = 'leave';
    // PlayerService#leave checks membership and the status itself, so that a retried leave gets
    // `player_not_found` even once the room has closed.
    access = 'signed_in';
    allowedStatuses = null;

    constructor({ playerService }) {
        this.playerService = playerService;
    }

    handle(work) {
        this.playerService.leave(work);
    }
}
