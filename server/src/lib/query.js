import { isDeepStrictEqual } from 'node:util';

// List/filter semantics for GET /api/entities/:name (see backend-contract.md).

export const DEFAULT_SORT = '-created_date';

export class QueryError extends Error {}

// --- Parsing -------------------------------------------------------------

export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFilter(raw) {
    if (raw === undefined || raw === '') {
        return {};
    }
    if (typeof raw !== 'string') {
        throw new QueryError('q must be a single JSON object');
    }

    let filter;
    try {
        filter = JSON.parse(raw);
    } catch {
        throw new QueryError('q is not valid JSON');
    }
    if (!isPlainObject(filter)) {
        throw new QueryError('q must be a JSON object');
    }
    return filter;
}

function parseNonNegativeInteger(raw, name) {
    if (raw === undefined || raw === '') {
        return null;
    }

    const isDigits = typeof raw === 'string' && /^\d+$/.test(raw);
    if (!isDigits) {
        throw new QueryError(`${name} must be a non-negative integer`);
    }
    return Number(raw);
}

function parseSort(raw) {
    if (raw === undefined || raw === '') {
        return DEFAULT_SORT;
    }
    if (typeof raw !== 'string') {
        throw new QueryError('sort must be a single field name');
    }
    return raw;
}

/**
 * Turns Express query params into { filter, sort, limit, skip }.
 * limit/skip are null when absent. Throws QueryError on bad input.
 */
export function parseListQuery(query) {
    return {
        filter: parseFilter(query.q),
        sort: parseSort(query.sort),
        limit: parseNonNegativeInteger(query.limit, 'limit'),
        skip: parseNonNegativeInteger(query.skip, 'skip'),
    };
}

// --- Filtering -----------------------------------------------------------

export function matchesFilter(record, filter) {
    for (const [field, expected] of Object.entries(filter)) {
        if (!Object.hasOwn(record, field) || !isDeepStrictEqual(record[field], expected)) {
            return false;
        }
    }
    return true;
}

// --- Sorting -------------------------------------------------------------

// Mixed types sort in a fixed order so results are deterministic:
// missing/null < booleans < numbers < strings < anything else (arrays/objects).
function typeRank(value) {
    if (value === undefined || value === null) {
        return 0;
    }
    if (typeof value === 'boolean') {
        return 1;
    }
    if (typeof value === 'number') {
        return 2;
    }
    if (typeof value === 'string') {
        return 3;
    }
    return 4;
}

function compareValues(left, right) {
    const rankDifference = typeRank(left) - typeRank(right);
    if (rankDifference !== 0) {
        return rankDifference;
    }

    const rank = typeRank(left);
    if (rank === 0) {
        return 0;
    }
    if (rank === 4) {
        // Arrays/objects have no natural order; compare their JSON for stability.
        left = JSON.stringify(left);
        right = JSON.stringify(right);
    }
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return 0;
}

/**
 * Sorts entries ({ seq, record }) by `sort` ("field" or "-field").
 * Ties fall back to insertion order (seq). Descending reverses the whole
 * ordering, tie-break included, so "-created_date" puts the newest record
 * first even when two share a millisecond.
 */
export function sortEntries(entries, sort) {
    const isDescending = sort.startsWith('-');
    const field = isDescending ? sort.slice(1) : sort;
    const direction = isDescending ? -1 : 1;

    return [...entries].sort((left, right) => {
        const byField = compareValues(left.record[field], right.record[field]);
        if (byField !== 0) {
            return byField * direction;
        }
        return (left.seq - right.seq) * direction;
    });
}

// --- Pagination ----------------------------------------------------------

export function paginate(items, skip, limit) {
    const start = skip ?? 0;
    if (limit === null) {
        return items.slice(start);
    }
    return items.slice(start, start + limit);
}
