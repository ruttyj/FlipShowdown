import { createSessionToken, normaliseName } from './auth.js';

// The signed-in user: found or created from a verified identity, renamed, given a dev session, and
// shaped for the API. A user's role is never stored; it comes from ADMIN_EMAILS on every read.

export class UserService {
    /**
     * `store` is the db.js store (its user functions are read at call time), `adminEmails` the Set
     * of admin addresses and `sessionSecret` the key dev session cookies are signed with.
     */
    constructor({ store, adminEmails, sessionSecret }) {
        this.store = store;
        this.adminEmails = adminEmails;
        this.sessionSecret = sessionSecret;
    }

    /** The users row for a verified identity ({ email, full_name }), created on first sight. */
    findOrCreate(identity) {
        const user = this.store.findUserByEmail(identity.email);
        if (user) {
            return user;
        }
        return this.store.upsertUser(identity.email, identity.full_name);
    }

    /**
     * The user after setting their name to `fullName` (trimmed and capped; empty clears it), or
     * unchanged when `fullName` is undefined.
     */
    rename(user, fullName) {
        if (fullName === undefined) {
            return user;
        }
        return this.store.setUserName(user.email, normaliseName(fullName));
    }

    /**
     * Signs a dev-mode user in: creates them on first sight (an existing user keeps their stored
     * name unless `fullName` is non-empty) and returns the session cookie's token. `email` and
     * `fullName` are already normalised.
     */
    startDevSession(email, fullName) {
        const user = this.store.upsertUser(email, fullName);
        return createSessionToken(this.sessionSecret, { email, full_name: user.full_name });
    }

    /** The API shape of a users row. */
    toResponse(user) {
        const role = this.adminEmails.has(user.email) ? 'admin' : 'user';
        return {
            id: user.id,
            email: user.email,
            full_name: user.full_name,
            role,
            created_date: user.created_date,
            updated_date: user.updated_date,
        };
    }
}
