import { canonicalEmail } from '../lib/email.js';
import { currentTimestamp, generateId } from './recordFields.js';

// The `users` table. Every method takes an email in any spelling and stores only the canonical one
// (users.email has a CHECK for it, migration 0002). Users come back as their raw rows:
// { id, email, full_name, created_date, updated_date }. A write the CHECK refuses (an empty email,
// say) throws the SqliteError unchanged, as the store always has.

/** Inserts a user with this canonical email and returns the new id. */
function insertUser(statements, storedEmail, fullName) {
    const id = generateId();
    const timestamp = currentTimestamp();
    statements.insert.run(id, storedEmail, fullName, timestamp, timestamp);
    return id;
}

export class UserRepository {
    /** `database` is a Database (or anything with its `prepare`). */
    constructor(database) {
        this.statements = {
            find: database.prepare('SELECT * FROM users WHERE email = ?'),
            insert: database.prepare(
                'INSERT INTO users (id, email, full_name, created_date, updated_date) VALUES (?, ?, ?, ?, ?)',
            ),
            updateName: database.prepare('UPDATE users SET full_name = ?, updated_date = ? WHERE email = ?'),
        };

        // Bound, so the method itself can be handed to a TableRepository as its resolveUserId.
        this.resolveId = this.resolveId.bind(this);
    }

    /** The user with this email, or null. */
    findByEmail(email) {
        return this.statements.find.get(canonicalEmail(email)) ?? null;
    }

    /**
     * Inserts the user on first sight and returns the stored user. An existing user keeps their
     * stored name unless a non-empty `fullName` different from it is given (e.g. from the dev login
     * form).
     */
    upsert(email, fullName) {
        const storedEmail = canonicalEmail(email);
        const existing = this.statements.find.get(storedEmail);

        if (!existing) {
            insertUser(this.statements, storedEmail, fullName || null);
        } else if (fullName && fullName !== existing.full_name) {
            this.statements.updateName.run(fullName, currentTimestamp(), storedEmail);
        }
        return this.statements.find.get(storedEmail);
    }

    /** Sets the user's name and returns the stored user, or null when there is no such user. */
    setName(email, fullName) {
        const storedEmail = canonicalEmail(email);
        this.statements.updateName.run(fullName, currentTimestamp(), storedEmail);
        return this.statements.find.get(storedEmail) ?? null;
    }

    /**
     * The id of the user with this email, creating the user if needed. Someone seated before they
     * ever signed in (by an admin, the generic API or a test) gets a user with no name, which their
     * first sign-in completes. This is the `resolveUserId` the tables with a user reference take.
     */
    resolveId(email) {
        const storedEmail = canonicalEmail(email);
        const existing = this.statements.find.get(storedEmail);
        if (existing) {
            return existing.id;
        }
        return insertUser(this.statements, storedEmail, null);
    }
}
