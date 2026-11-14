import { isHostPlayer } from '../domain/players.js';

// Hold-to-vote topics (see managers/votes.js), by topic name, as the realtime hub takes them. Each
// topic has:
//   validateOption(room, players, option) - whether `option` may be voted for right now; `room` is
//     the GameRoom record or null, `players` its Players
//   resolve(roomId, option) - carries out a passed vote; returns the RoomActionRunner result
//   hostDecides - true when the online host holding an option passes it alone, after the same
//     hold time

function isValidNewHost(room, players, playerId) {
    if (!room || room.status === 'closed') {
        return false;
    }

    const player = players.find((candidate) => candidate.id === playerId);
    if (!player) {
        return false;
    }
    return !isHostPlayer(room, player);
}

/** make-host: the players vote another player in as host. */
export class MakeHostVoteTopic {
    // The host may hand the role over without a vote.
    hostDecides = true;

    /** `runner` is a RoomActionRunner and `makeHostAction` the registry's make-host handler. */
    constructor({ runner, makeHostAction }) {
        this.runner = runner;
        this.makeHostAction = makeHostAction;
    }

    validateOption(room, players, option) {
        return isValidNewHost(room, players, option);
    }

    /** Runs make-host as the server: the vote stands in for the host's permission. */
    resolve(roomId, option) {
        return this.runner.runAsSystem(this.makeHostAction, roomId, { player_id: option });
    }
}

/** The topics by name. `actions` is { runner, makeHostAction } (see MakeHostVoteTopic). */
export function createVoteTopics(actions) {
    return {
        'make-host': new MakeHostVoteTopic(actions),
    };
}
