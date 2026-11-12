// Entity clients: `backend.entities.<Name>.list/filter/get/create/...` over the REST API.

import { request } from './httpClient.js';

function entityPath(name, id) {
    const base = `/api/entities/${encodeURIComponent(name)}`;
    if (id === undefined) {
        return base;
    }
    return `${base}/${encodeURIComponent(id)}`;
}

/**
 * Creates the client for one entity type.
 *
 * @param {string} name                       entity name, e.g. 'Player'
 * @param {import('./realtime.js').RealtimeConnection} realtime
 */
export function createEntityClient(name, realtime) {
    return {
        /** All records; `sort` is a field name with optional '-' prefix for descending. */
        list(sort, limit, skip) {
            return request('GET', entityPath(name), { query: { sort, limit, skip } });
        },

        /** Records whose top-level fields equal every field in `query`. */
        filter(query, sort, limit, skip) {
            const q = JSON.stringify(query ?? {});
            return request('GET', entityPath(name), { query: { q, sort, limit, skip } });
        },

        get(id) {
            return request('GET', entityPath(name, id));
        },

        create(data) {
            return request('POST', entityPath(name), { body: data });
        },

        bulkCreate(records) {
            return request('POST', `${entityPath(name)}/bulk`, { body: records });
        },

        /** Shallow-merges `data` into the record. */
        update(id, data) {
            return request('PUT', entityPath(name, id), { body: data });
        },

        delete(id) {
            return request('DELETE', entityPath(name, id));
        },

        /** callback({ type, id, data, timestamp }) on every change; returns unsubscribe(). */
        subscribe(callback) {
            return realtime.subscribe(name, callback);
        },
    };
}

/**
 * Object where any property name yields that entity's client, so
 * `entities.GameRoom` works without listing entity names here. Clients are cached.
 *
 * @returns {Object<string, ReturnType<typeof createEntityClient>>}
 */
export function createEntitiesProxy(realtime) {
    const clients = new Map();

    return new Proxy({}, {
        get(_target, property) {
            // Symbols (e.g. from console inspection) and 'then' (checked by `await` and
            // promise helpers) must not be mistaken for entity names.
            if (typeof property !== 'string' || property === 'then') {
                return undefined;
            }

            if (!clients.has(property)) {
                clients.set(property, createEntityClient(property, realtime));
            }
            return clients.get(property);
        },
    });
}
