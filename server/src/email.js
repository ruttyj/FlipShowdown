// Email spelling rules shared by auth, the store and the realtime hub. The database stores only the
// canonical form, and a CHECK on users.email enforces it (migration 0002).

const MAX_EMAIL_LENGTH = 254;

/**
 * The stored spelling of an email: trimmed and lower-cased, without checking that it looks like an
 * address (" Ann@X.com " -> "ann@x.com"). Null for anything that isn't a string.
 */
export function canonicalEmail(value) {
    if (typeof value !== 'string') {
        return null;
    }
    return value.trim().toLowerCase();
}

/** Lower-cased, trimmed email, or null when it doesn't look like one. */
export function normaliseEmail(value) {
    const email = canonicalEmail(value);
    if (email === null) {
        return null;
    }

    const looksValid = email.length <= MAX_EMAIL_LENGTH && /^[^\s@]+@[^\s@]+$/.test(email);
    if (!looksValid) {
        return null;
    }
    return email;
}
