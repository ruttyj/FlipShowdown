// localStorage can throw (private windows, blocked site data) or hold bad JSON.
// These helpers never throw: reads fall back, writes are silently skipped.

export function readJson(storage, key, fallback) {
    try {
        const raw = storage.getItem(key);
        if (raw === null || raw === undefined) {
            return fallback;
        }
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function writeJson(storage, key, value) {
    try {
        storage.setItem(key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

// The real localStorage, or null when even touching it throws.
export function getLocalStorage() {
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

export function readLocalJson(key, fallback) {
    const storage = getLocalStorage();
    if (!storage) {
        return fallback;
    }
    return readJson(storage, key, fallback);
}

export function writeLocalJson(key, value) {
    const storage = getLocalStorage();
    if (!storage) {
        return false;
    }
    return writeJson(storage, key, value);
}

export function removeLocal(key) {
    const storage = getLocalStorage();
    if (!storage) {
        return;
    }
    try {
        storage.removeItem(key);
    } catch {
        // Storage blocked: there is nothing stored to remove.
    }
}
