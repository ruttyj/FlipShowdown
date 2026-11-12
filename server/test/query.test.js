import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { paginate, parseListQuery, QueryError, sortEntries } from '../src/query.js';

function entriesOf(records) {
    return records.map((record, index) => ({ seq: index, record }));
}

function sortedValues(records, sort, field = 'v') {
    return sortEntries(entriesOf(records), sort).map((entry) => entry.record[field]);
}

// --- Parsing -------------------------------------------------------------

describe('parseListQuery', () => {
    test('defaults when nothing is given', () => {
        assert.deepEqual(parseListQuery({}), { filter: {}, sort: '-created_date', limit: null, skip: null });
        assert.deepEqual(parseListQuery({ q: '', sort: '', limit: '', skip: '' }), {
            filter: {},
            sort: '-created_date',
            limit: null,
            skip: null,
        });
    });

    test('parses a valid filter, sort, limit and skip', () => {
        const parsed = parseListQuery({ q: '{"a":1}', sort: 'name', limit: '5', skip: '0' });
        assert.deepEqual(parsed, { filter: { a: 1 }, sort: 'name', limit: 5, skip: 0 });
    });

    test('malformed JSON in q is a QueryError', () => {
        assert.throws(() => parseListQuery({ q: '{oops' }), QueryError);
    });

    test('a filter that is not an object is a QueryError', () => {
        for (const raw of ['[1]', '"x"', '5', 'null', 'true']) {
            assert.throws(() => parseListQuery({ q: raw }), QueryError, raw);
        }
    });

    test('repeated parameters (arrays) are rejected', () => {
        assert.throws(() => parseListQuery({ q: ['{}', '{}'] }), QueryError);
        assert.throws(() => parseListQuery({ sort: ['a', 'b'] }), QueryError);
        assert.throws(() => parseListQuery({ limit: ['1', '2'] }), QueryError);
    });

    test('negative, fractional and non-numeric limit/skip are rejected', () => {
        for (const raw of ['-1', '1.5', 'abc', '1e3', ' 2', '0x10']) {
            assert.throws(() => parseListQuery({ limit: raw }), QueryError, `limit ${raw}`);
            assert.throws(() => parseListQuery({ skip: raw }), QueryError, `skip ${raw}`);
        }
    });
});

// --- Sorting -------------------------------------------------------------

describe('sortEntries', () => {
    test('mixed types follow typeRank: null < boolean < number < string < other', () => {
        const records = [
            { v: 'b' },
            { v: [1] },
            { v: 3 },
            { v: true },
            { v: null },
            { v: 'a' },
            { v: false },
            { v: 1 },
            { v: { x: 1 } },
        ];
        assert.deepEqual(sortedValues(records, 'v'), [null, false, true, 1, 3, 'a', 'b', [1], { x: 1 }]);
    });

    test('descending reverses the whole ordering', () => {
        const records = [{ v: 1 }, { v: 'a' }, { v: null }];
        assert.deepEqual(sortedValues(records, '-v'), ['a', 1, null]);
    });

    test('records missing the field sort with null and keep insertion order', () => {
        const records = [{ v: 2, id: 'a' }, { id: 'b' }, { v: null, id: 'c' }, { v: 1, id: 'd' }];
        assert.deepEqual(sortedValues(records, 'v', 'id'), ['b', 'c', 'd', 'a']);
    });

    test('ties fall back to insertion order, reversed when descending', () => {
        const records = [{ v: 1, id: 'a' }, { v: 1, id: 'b' }];
        assert.deepEqual(sortedValues(records, 'v', 'id'), ['a', 'b']);
        assert.deepEqual(sortedValues(records, '-v', 'id'), ['b', 'a']);
    });

    test('equal arrays and objects tie by JSON, differing ones order by JSON', () => {
        const records = [{ v: [2], id: 'a' }, { v: [1], id: 'b' }, { v: [1], id: 'c' }];
        assert.deepEqual(sortedValues(records, 'v', 'id'), ['b', 'c', 'a']);
    });

    test('a nested field name is a literal key, so nested values do not sort', () => {
        const records = [{ a: { b: 2 }, id: 'x' }, { a: { b: 1 }, id: 'y' }];
        // "a.b" is not a key on either record, so insertion order holds.
        assert.deepEqual(sortedValues(records, 'a.b', 'id'), ['x', 'y']);
    });

    test('sorting by an object-valued field orders by the JSON of that value', () => {
        const records = [{ a: { b: 2 }, id: 'x' }, { a: { b: 1 }, id: 'y' }];
        assert.deepEqual(sortedValues(records, 'a', 'id'), ['y', 'x']);
    });

    test('does not mutate the input', () => {
        const entries = entriesOf([{ v: 2 }, { v: 1 }]);
        sortEntries(entries, 'v');
        assert.equal(entries[0].record.v, 2);
    });
});

// --- Pagination ----------------------------------------------------------

describe('paginate', () => {
    test('applies skip and limit', () => {
        assert.deepEqual(paginate([1, 2, 3, 4], 1, 2), [2, 3]);
        assert.deepEqual(paginate([1, 2, 3, 4], null, null), [1, 2, 3, 4]);
        assert.deepEqual(paginate([1, 2, 3, 4], 3, null), [4]);
        assert.deepEqual(paginate([1, 2, 3], 0, 0), []);
    });
});
