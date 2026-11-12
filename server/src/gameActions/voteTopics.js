import { makeHostAction } from './players.js';
import { isHostPlayer, runRoomAction, SYSTEM_USER } from './roomTx.js';

// Hold-to-vote topics (see votes.js). Each entry is:
//   validateOption(room, players, option) - whether `option` may be voted for
//     right now; `room` is the GameRoom record or null, `players` its Players
//   resolve(roomId, option) - carries out a passed vote; returns the
//     runRoomAction result
//   hostDecides - true when the online host holding an option passes it
//     alone, after the same hold time

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

/**
 * Runs a game action on behalf of the room's players rather than a user: the
 * host check is skipped, but the status check and the normal event
 * publishing still apply.
 */
function runSystemAction(context, roomId, action, body) {
    const request = {
        user: SYSTEM_USER,
        roomId,
        access: 'system',
        allowedStatuses: action.allowedStatuses,
    };
    return runRoomAction(context, request, (tx) => action.run(tx, body));
}

/** `context` is the app context; its `hub` only has to be set by the time a vote passes. */
export function createVoteTopics(context) {
    return {
        'make-host': {
            // The host may hand the role over without a vote.
            hostDecides: true,
            validateOption(room, players, option) {
                return isValidNewHost(room, players, option);
            },
            resolve(roomId, option) {
                return runSystemAction(context, roomId, makeHostAction, { player_id: option });
            },
        },
    };
}
