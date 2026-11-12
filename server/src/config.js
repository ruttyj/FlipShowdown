import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalEmail } from './email.js';

// The server/ folder, so relative defaults don't depend on the working directory.
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The SQLite database's file name inside DATA_DIR.
export const DATABASE_FILE = 'flip7.db';

const DEFAULT_ENTITIES =['GameRoom', 'Player', 'RoundScore', 'ChatMessage'];

// Docker networks and the loopback interface are where cloudflared connects from.
const DEFAULT_TRUST_PROXY = 'loopback, linklocal, uniquelocal';

// Stable, fast and cheap, which suits reading a handful of cards.
// (There is no "gemini-3.5-flash"; the 3.5 generation only has Flash-Lite.)
const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

// --- Parsing helpers -----------------------------------------------------

function parseCommaList(value) {
    if (!value) {
        return [];
    }

    const items = [];
    for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed !== '') {
            items.push(trimmed);
        }
    }
    return items;
}

function parsePort(value) {
    if (value === undefined || value === '') {
        return 7001;
    }

    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid PORT: ${value}`);
    }
    return port;
}

/**
 * Accepts "team.cloudflareaccess.com", "https://team.cloudflareaccess.com/" etc.
 * and returns the bare host name.
 */
function normaliseTeamDomain(value) {
    if (!value) {
        return null;
    }
    return value.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * Reads the session secret saved in the data folder, creating it on first boot. Keeping it
 * on disk means restarts (nodemon, container rebuilds) don't log everyone out.
 */
function readOrCreateSessionSecret(dataDir) {
    const secretPath = path.join(dataDir, 'session-secret');
    if (fs.existsSync(secretPath)) {
        const saved = fs.readFileSync(secretPath, 'utf8').trim();
        if (saved !== '') {
            return saved;
        }
    }

    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    return secret;
}

const TRUE_FLAG_VALUES = ['true', '1', 'yes', 'on'];
const FALSE_FLAG_VALUES = ['false', '0', 'no', 'off'];

/**
 * Parses the boolean environment variable `name`: true for "true", "1",
 * "yes" or "on" and false for "false", "0", "no" or "off" (any case). Unset
 * or blank gives the default. Anything else throws, like parsePort, so a
 * typo fails at boot instead of silently using the default (X22).
 */
function parseFlag(name, value, defaultValue) {
    const normalised = (value || '').trim().toLowerCase();
    if (normalised === '') {
        return defaultValue;
    }
    if (TRUE_FLAG_VALUES.includes(normalised)) {
        return true;
    }
    if (FALSE_FLAG_VALUES.includes(normalised)) {
        return false;
    }
    throw new Error(`Invalid ${name}: "${value}" (expected true/false, 1/0, yes/no or on/off)`);
}

/**
 * Parses HOST_OFFLINE_GRACE_SECONDS into milliseconds. Unset or blank gives
 * null (the realtime hub's default); anything but a number >= 0 throws.
 */
function parseHostOfflineGrace(value) {
    const trimmed = (value || '').trim();
    if (trimmed === '') {
        return null;
    }

    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds < 0) {
        throw new Error(`Invalid HOST_OFFLINE_GRACE_SECONDS: "${value}" (expected a number of seconds, 0 or more)`);
    }
    return seconds * 1000;
}

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_STALE_ROOM_HOURS = 24;

/**
 * Parses STALE_ROOM_HOURS into milliseconds (X81). Unset or blank gives 24 hours, and 0 gives
 * null, which turns the stale-room sweep off. Anything but a number >= 0 throws.
 */
function parseStaleRoomHours(value) {
    const trimmed = (value || '').trim();
    if (trimmed === '') {
        return DEFAULT_STALE_ROOM_HOURS * HOUR_MS;
    }

    const hours = Number(trimmed);
    if (!Number.isFinite(hours) || hours < 0) {
        throw new Error(`Invalid STALE_ROOM_HOURS: "${value}" (expected a number of hours, 0 to turn the sweep off)`);
    }
    if (hours === 0) {
        return null;
    }
    return hours * HOUR_MS;
}

// --- Config loading ------------------------------------------------------

/** The absolute DATA_DIR; relative paths are from server/. Also used by the backup script. */
export function resolveDataDir(env) {
    return path.resolve(SERVER_ROOT, env.DATA_DIR || './data');
}

/**
 * Builds the server configuration from environment variables (see
 * docs/backend-contract.md). Throws when the combination is unusable, so the
 * process fails fast at boot instead of on the first request.
 */
export function loadConfig(env = process.env) {
    const authMode = (env.AUTH_MODE || 'dev').trim().toLowerCase();
    if (authMode !== 'dev' && authMode !== 'cloudflare') {
        throw new Error(`Invalid AUTH_MODE "${env.AUTH_MODE}" (expected "dev" or "cloudflare")`);
    }

    const cfTeamDomain = normaliseTeamDomain(env.CF_ACCESS_TEAM_DOMAIN);
    const cfAudience = env.CF_ACCESS_AUD ? env.CF_ACCESS_AUD.trim() : null;
    const isCloudflareMisconfigured = authMode === 'cloudflare' && (!cfTeamDomain || !cfAudience);
    if (isCloudflareMisconfigured) {
        throw new Error('AUTH_MODE=cloudflare requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD');
    }

    const dataDir = resolveDataDir(env);

    const sessionSecretGenerated = !env.SESSION_SECRET;
    let sessionSecret = env.SESSION_SECRET;
    if (sessionSecretGenerated) {
        sessionSecret = readOrCreateSessionSecret(dataDir);
    }

    let entities = parseCommaList(env.ENTITIES);
    if (entities.length === 0) {
        entities = DEFAULT_ENTITIES;
    }

    // The spelling users.email and signed-in identities use, so a plain lookup matches.
    const listedAdminEmails = parseCommaList(env.ADMIN_EMAILS).map(canonicalEmail);

    // The dev login page takes any email without a password, and `npm run share` and the desktop
    // launcher put it on a public URL, so in dev mode anyone could sign in as an admin. Admins are
    // only honoured there when DEV_ALLOW_ADMINS opts in (the server tests do) (X89).
    const isDevAdminAllowed = parseFlag('DEV_ALLOW_ADMINS', env.DEV_ALLOW_ADMINS, false);
    const adminEmailsIgnored = authMode === 'dev' && !isDevAdminAllowed && listedAdminEmails.length > 0;
    let adminEmails = listedAdminEmails;
    if (adminEmailsIgnored) {
        adminEmails = [];
    }

    // An empty key disables AI card scanning instead of failing at boot.
    const geminiApiKey = (env.GEMINI_API_KEY || '').trim() || null;
    const geminiModel = (env.GEMINI_MODEL || '').trim() || DEFAULT_GEMINI_MODEL;

    return {
        port: parsePort(env.PORT),
        dataDir,
        staticDir: path.resolve(SERVER_ROOT, env.STATIC_DIR || '../dist'),
        authMode,
        sessionSecret,
        sessionSecretGenerated,
        cfTeamDomain,
        cfAudience,
        adminEmails: new Set(adminEmails),
        adminEmailsIgnored,
        entities: new Set(entities),
        trustProxy: env.TRUST_PROXY || DEFAULT_TRUST_PROXY,
        geminiApiKey,
        geminiModel,
        lockGameEntities: parseFlag('LOCK_GAME_ENTITIES', env.LOCK_GAME_ENTITIES, true),
        hostOfflineGraceMs: parseHostOfflineGrace(env.HOST_OFFLINE_GRACE_SECONDS),
        staleRoomMaxIdleMs: parseStaleRoomHours(env.STALE_ROOM_HOURS),
    };
}
