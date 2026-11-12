// Stores every email in one canonical spelling (trimmed, lower-case) and makes the database
// enforce it:
// - users that differ only by case or spaces merge into one;
// - users is rebuilt with a CHECK, so a non-canonical email can't be inserted any more;
// - the emails inside records (a Player's email, a GameRoom's host_email, every created_by) are
//   rewritten, so they still match their user.
// Players refer to users by email at this version, so the merge needs no other re-pointing.

/** Frozen copy of canonicalEmail in src/email.js (migrations never import from src/). */
function canonical(email) {
    return email.trim().toLowerCase();
}

// --- Users -------------------------------------------------------------------

/**
 * One row per canonical email. `users` must be oldest first: the oldest account survives (it's
 * the one people have used longest) and keeps its name, or takes the first name another account
 * in its group has when it has none. Accounts whose email is blank are dropped: nobody can sign
 * in with them, and nothing refers to users by id yet.
 */
function mergeUsers(users) {
    const survivors = new Map();
    for (const user of users) {
        const email = canonical(user.email);
        if (email === '') {
            continue;
        }

        const survivor = survivors.get(email);
        if (!survivor) {
            survivors.set(email, { ...user, email });
        } else if (!survivor.full_name) {
            survivor.full_name = user.full_name;
        }
    }
    return [...survivors.values()];
}

/** SQLite can't add a CHECK to an existing table, so users is rebuilt with the merged rows. */
function rebuildUsers(db, users) {
    // lower() and trim() only fold ASCII letters and spaces, so this is weaker than canonical(),
    // but canonical() output always passes it.
    db.exec(`
        CREATE TABLE users_new (
            id           TEXT PRIMARY KEY,
            email        TEXT NOT NULL UNIQUE CHECK (email <> '' AND email = lower(trim(email))),
            full_name    TEXT,
            created_date TEXT NOT NULL,
            updated_date TEXT NOT NULL
        )
    `);

    const insert = db.prepare(
        'INSERT INTO users_new (id, email, full_name, created_date, updated_date) VALUES (?, ?, ?, ?, ?)',
    );
    for (const user of users) {
        insert.run(user.id, user.email, user.full_name, user.created_date, user.updated_date);
    }

    db.exec('DROP TABLE users');
    db.exec('ALTER TABLE users_new RENAME TO users');
}

function normaliseUsers(db) {
    const users = db.prepare('SELECT * FROM users ORDER BY created_date, rowid').all();
    rebuildUsers(db, mergeUsers(users));
}

// --- Records -----------------------------------------------------------------

// The field of each entity's data that holds a user's email.
const EMAIL_FIELD_BY_ENTITY = new Map([
    ['Player', 'email'],
    ['GameRoom', 'host_email'],
]);

/** The record's data JSON with its email field canonical, or the same text when nothing changes. */
function canonicaliseDataEmail(entity, dataText) {
    const field = EMAIL_FIELD_BY_ENTITY.get(entity);
    if (!field) {
        return dataText;
    }

    const data = JSON.parse(dataText);
    const email = data[field];
    const isAlreadyCanonical = typeof email !== 'string' || canonical(email) === email;
    if (isAlreadyCanonical) {
        return dataText;
    }

    data[field] = canonical(email);
    return JSON.stringify(data);
}

function canonicaliseCreatedBy(createdBy) {
    if (typeof createdBy !== 'string') {
        return createdBy;
    }
    return canonical(createdBy);
}

/** Leaves updated_date alone: this is a spelling fix, not an edit anyone made. */
function normaliseRecords(db) {
    const rows = db.prepare('SELECT seq, entity, data, created_by FROM records').all();
    const update = db.prepare('UPDATE records SET data = ?, created_by = ? WHERE seq = ?');

    for (const row of rows) {
        const data = canonicaliseDataEmail(row.entity, row.data);
        const createdBy = canonicaliseCreatedBy(row.created_by);
        const isChanged = data !== row.data || createdBy !== row.created_by;
        if (isChanged) {
            update.run(data, createdBy, row.seq);
        }
    }
}

export function up(db) {
    normaliseUsers(db);
    normaliseRecords(db);
}
