import { CLIENT_MESSAGE } from '../../../../shared/realtimeProtocol.js';

/** vote-release: the socket lets go of its hold in a room's vote. Message { room_id, topic }. */
export class VoteReleaseHandler {
    type = CLIENT_MESSAGE.VOTE_RELEASE;
    #votes;

    /** `votes` is the VoteManager. */
    constructor({ votes }) {
        this.#votes = votes;
    }

    handle(socket, message) {
        this.#votes.release(socket, message);
    }
}
