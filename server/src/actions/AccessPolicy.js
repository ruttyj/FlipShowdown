import { ActionError } from '../domain/errors.js';

// Who may run an action on a room. Each action declares one access level:
//   'signed_in' - anyone signed in
//   'member'    - the caller must have a Player (admins too: these actions are about the
//                 caller's own Player)
//   'host'      - the caller is room.host_email, or an admin
//   'system'    - the server itself (a passed vote or the stale-room sweep, user SYSTEM_USER);
//                 no check
// Stateless: `work` is the action's RoomUnitOfWork, with its room loaded.

function notMember() {
    return new ActionError(403, 'not_member', 'You are not in this room');
}

export class AccessPolicy {
    /** Whether the caller is the room's host (by host_email) or an admin. */
    isHost(work) {
        return work.isAdmin || work.room.host_email === work.user.email;
    }

    /** Throws a 403 ActionError when the caller doesn't have `access` to the room. */
    check(work, access) {
        if (access === 'signed_in' || access === 'system') {
            return;
        }

        const callerPlayer = work.findCallerPlayer();
        if (access === 'member') {
            if (!callerPlayer) {
                throw notMember();
            }
            return;
        }
        if (access === 'host') {
            if (this.isHost(work)) {
                return;
            }
            if (!callerPlayer) {
                throw notMember();
            }
            throw new ActionError(403, 'not_host', 'Only the host can do that');
        }

        // A typo in an action definition must not silently let everyone in.
        throw new Error(`Unknown access level: ${access}`);
    }
}
