import { CLIENT_MESSAGE } from '../../../../shared/realtimeProtocol.js';

/** vote-hold: the socket's player holds an option in a room's vote. Message { room_id, topic, option }. */
export class VoteHoldHandler {
    type = CLIENT_MESSAGE.VOTE_HOLD;
    #votes;

    /** `votes` is the VoteManager. */
    constructor({ votes }) {
        this.#votes = votes;
    }

    handle(socket, message) {
        this.#votes.hold(socket, message);
    }
}
