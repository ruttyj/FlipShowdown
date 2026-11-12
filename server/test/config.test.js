import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { loadConfig } from '../src/config.js';

let dataDir;

before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-config-'));
});

after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Config for a base env that never touches the real data folder. */
function load(extra = {}) {
    return loadConfig({ SESSION_SECRET: 'secret', DATA_DIR: dataDir, ...extra });
}

// --- PORT ---------------------------------------------------------------

test('PORT defaults to 7001 and accepts a valid number', () => {
    assert.equal(load().port, 7001);
    assert.equal(load({ PORT: '' }).port, 7001);
    assert.equal(load({ PORT: '8080' }).port, 8080);
    assert.equal(load({ PORT: '65535' }).port, 65535);
});

test('PORT that is invalid, 0 or above 65535 is rejected', () => {
    for (const port of ['abc', '0', '-1', '65536', '80.5', ' ']) {
        assert.throws(() => load({ PORT: port }), /Invalid PORT/, port);
    }
});

// --- Flags --------------------------------------------------------------

test('LOCK_GAME_ENTITIES accepts true/false/1/0/yes/no/on/off in any case', () => {
    for (const value of ['true', 'TRUE', '1', 'yes', 'Yes', ' yes ', 'on', 'On', 'ON']) {
        assert.equal(load({ LOCK_GAME_ENTITIES: value }).lockGameEntities, true, value);
    }
    for (const value of ['false', 'False', '0', 'no', 'NO', 'off', 'Off', ' OFF ']) {
        assert.equal(load({ LOCK_GAME_ENTITIES: value }).lockGameEntities, false, value);
    }
});

test('LOCK_GAME_ENTITIES falls back to the default (true) when unset or empty', () => {
    assert.equal(load().lockGameEntities, true);
    assert.equal(load({ LOCK_GAME_ENTITIES: '' }).lockGameEntities, true);
    assert.equal(load({ LOCK_GAME_ENTITIES: '  ' }).lockGameEntities, true);
});

test('LOCK_GAME_ENTITIES with an unrecognised value fails at start-up', () => {
    for (const value of ['maybe', 'enabled', '2', 'y']) {
        assert.throws(() => load({ LOCK_GAME_ENTITIES: value }), /Invalid LOCK_GAME_ENTITIES/, value);
    }
});

test('HOST_OFFLINE_GRACE_SECONDS is read as seconds, and unset leaves the default', () => {
    assert.equal(load().hostOfflineGraceMs, null);
    assert.equal(load({ HOST_OFFLINE_GRACE_SECONDS: ' ' }).hostOfflineGraceMs, null);
    assert.equal(load({ HOST_OFFLINE_GRACE_SECONDS: '0' }).hostOfflineGraceMs, 0);
    assert.equal(load({ HOST_OFFLINE_GRACE_SECONDS: '2.5' }).hostOfflineGraceMs, 2500);
});

test('HOST_OFFLINE_GRACE_SECONDS that is negative or not a number fails at start-up', () => {
    for (const value of ['-1', 'two', 'Infinity']) {
        assert.throws(() => load({ HOST_OFFLINE_GRACE_SECONDS: value }), /Invalid HOST_OFFLINE_GRACE_SECONDS/, value);
    }
});

test('STALE_ROOM_HOURS defaults to 24 hours and 0 turns the sweep off', () => {
    const hourMs = 60 * 60 * 1000;
    assert.equal(load().staleRoomMaxIdleMs, 24 * hourMs);
    assert.equal(load({ STALE_ROOM_HOURS: ' ' }).staleRoomMaxIdleMs, 24 * hourMs);
    assert.equal(load({ STALE_ROOM_HOURS: '72' }).staleRoomMaxIdleMs, 72 * hourMs);
    assert.equal(load({ STALE_ROOM_HOURS: '0.5' }).staleRoomMaxIdleMs, hourMs / 2);
    assert.equal(load({ STALE_ROOM_HOURS: '0' }).staleRoomMaxIdleMs, null);
});

test('STALE_ROOM_HOURS that is negative or not a number fails at start-up', () => {
    for (const value of ['-1', 'day', 'Infinity']) {
        assert.throws(() => load({ STALE_ROOM_HOURS: value }), /Invalid STALE_ROOM_HOURS/, value);
    }
});

// --- Auth mode ----------------------------------------------------------

test('AUTH_MODE defaults to dev and rejects unknown values', () => {
    assert.equal(load().authMode, 'dev');
    assert.equal(load({ AUTH_MODE: ' Dev ' }).authMode, 'dev');
    assert.throws(() => load({ AUTH_MODE: 'basic' }), /Invalid AUTH_MODE/);
});

test('CF_ACCESS_TEAM_DOMAIN with https:// or a trailing slash is normalised', () => {
    const base = { AUTH_MODE: 'cloudflare', CF_ACCESS_AUD: ' aud ' };
    const domains = [
        'team.cloudflareaccess.com',
        'https://team.cloudflareaccess.com/',
        'HTTP://team.cloudflareaccess.com//',
        '  team.cloudflareaccess.com  ',
    ];
    for (const domain of domains) {
        const config = load({ ...base, CF_ACCESS_TEAM_DOMAIN: domain });
        assert.equal(config.cfTeamDomain, 'team.cloudflareaccess.com', domain);
        assert.equal(config.cfAudience, 'aud');
    }
});

test('AUTH_MODE=cloudflare without the domain or audience fails at start-up', () => {
    const message = /requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD/;
    assert.throws(() => load({ AUTH_MODE: 'cloudflare' }), message);
    assert.throws(() => load({ AUTH_MODE: 'cloudflare', CF_ACCESS_TEAM_DOMAIN: 'team.example.com' }), message);
    assert.throws(() => load({ AUTH_MODE: 'cloudflare', CF_ACCESS_AUD: 'aud' }), message);
});

// --- Session secret -----------------------------------------------------

test('SESSION_SECRET from the environment is used as given', () => {
    const config = load({ SESSION_SECRET: 'abc' });
    assert.equal(config.sessionSecret, 'abc');
    assert.equal(config.sessionSecretGenerated, false);
});

test('without SESSION_SECRET the secret is generated once and reused on the next load', () => {
    const freshDir = path.join(dataDir, 'fresh');
    const env = { DATA_DIR: freshDir };

    const first = loadConfig(env);
    const second = loadConfig(env);

    assert.equal(first.sessionSecretGenerated, true);
    assert.match(first.sessionSecret, /^[0-9a-f]{64}$/);
    assert.equal(second.sessionSecret, first.sessionSecret);
    assert.equal(fs.readFileSync(path.join(freshDir, 'session-secret'), 'utf8'), first.sessionSecret);
});

test('an empty saved secret file is replaced with a new secret', () => {
    const emptyDir = path.join(dataDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    fs.writeFileSync(path.join(emptyDir, 'session-secret'), '  \n');

    const config = loadConfig({ DATA_DIR: emptyDir });

    assert.match(config.sessionSecret, /^[0-9a-f]{64}$/);
});

// --- Lists and misc -----------------------------------------------------

test('ADMIN_EMAILS and ENTITIES with blanks and spaces are parsed cleanly', () => {
    const config = load({
        ADMIN_EMAILS: ' Bob@Example.com, ,alice@example.com,, ',
        DEV_ALLOW_ADMINS: 'true',
        ENTITIES: ' A , ,B,',
    });

    assert.deepEqual([...config.adminEmails], ['bob@example.com', 'alice@example.com']);
    assert.deepEqual([...config.entities], ['A', 'B']);
});

test('empty ENTITIES falls back to the defaults and ADMIN_EMAILS to none', () => {
    const config = load({ ENTITIES: ' , ' });

    assert.deepEqual([...config.entities], ['GameRoom', 'Player', 'RoundScore', 'ChatMessage']);
    assert.equal(config.adminEmails.size, 0);
});

// The dev login page has no password and `npm run share` puts it on a public URL, so anyone could
// type an admin's email (X89).
test('dev mode ignores ADMIN_EMAILS unless DEV_ALLOW_ADMINS opts in', () => {
    const ignored = load({ AUTH_MODE: 'dev', ADMIN_EMAILS: 'boss@example.com' });
    assert.equal(ignored.adminEmails.size, 0);
    assert.equal(ignored.adminEmailsIgnored, true);

    const allowed = load({ AUTH_MODE: 'dev', ADMIN_EMAILS: 'boss@example.com', DEV_ALLOW_ADMINS: 'yes' });
    assert.deepEqual([...allowed.adminEmails], ['boss@example.com']);
    assert.equal(allowed.adminEmailsIgnored, false);
});

test('without ADMIN_EMAILS nothing is reported as ignored', () => {
    assert.equal(load({ AUTH_MODE: 'dev' }).adminEmailsIgnored, false);
});

test('cloudflare mode keeps ADMIN_EMAILS without the opt-in', () => {
    const config = load({
        AUTH_MODE: 'cloudflare',
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUD: 'aud',
        ADMIN_EMAILS: 'boss@example.com',
    });
    assert.deepEqual([...config.adminEmails], ['boss@example.com']);
    assert.equal(config.adminEmailsIgnored, false);
});

test('DEV_ALLOW_ADMINS with an unrecognised value fails at start-up', () => {
    assert.throws(() => load({ DEV_ALLOW_ADMINS: 'maybe' }), /Invalid DEV_ALLOW_ADMINS/);
});

test('Gemini settings default sensibly and trim input', () => {
    const defaults = load();
    assert.equal(defaults.geminiApiKey, null);
    assert.equal(defaults.geminiModel, 'gemini-3.5-flash-lite');

    const custom = load({ GEMINI_API_KEY: ' key ', GEMINI_MODEL: ' m ' });
    assert.equal(custom.geminiApiKey, 'key');
    assert.equal(custom.geminiModel, 'm');
});

test('paths resolve and TRUST_PROXY is passed through', () => {
    const config = load({ STATIC_DIR: '/abs/static', TRUST_PROXY: '1' });
    assert.equal(config.staticDir, path.resolve('/abs/static'));
    assert.equal(config.trustProxy, '1');
    assert.match(load().trustProxy, /loopback/);
    assert.ok(path.isAbsolute(load().staticDir));
});
