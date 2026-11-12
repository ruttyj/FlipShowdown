import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normaliseEmail as authNormaliseEmail } from '../src/auth.js';
import { canonicalEmail, normaliseEmail } from '../src/email.js';

// canonicalEmail is the one spelling of an email the database stores; normaliseEmail also
// checks it looks like an address. Shape rejection is covered in auth.test.js.

describe('canonicalEmail', () => {
    test('trims and lower-cases a string without validating it', () => {
        assert.equal(canonicalEmail('  Ann@Example.COM '), 'ann@example.com');
        assert.equal(canonicalEmail(' not an email '), 'not an email');
        assert.equal(canonicalEmail('   '), '');
    });

    test('returns null for anything that is not a string', () => {
        for (const value of [null, undefined, 5, {}, ['a@b.c']]) {
            assert.equal(canonicalEmail(value), null, String(value));
        }
    });
});

describe('normaliseEmail', () => {
    test('returns the canonical form of a valid address', () => {
        assert.equal(normaliseEmail(' Bob@X.com '), canonicalEmail(' Bob@X.com '));
    });

    test('is the same function auth.js exports, so its importers are unchanged', () => {
        assert.equal(authNormaliseEmail, normaliseEmail);
    });
});
