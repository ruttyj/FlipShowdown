import * as baseline from './0001_baseline.js';
import * as normaliseEmails from './0002_normalise_emails.js';
import * as gameTables from './0003_game_tables.js';
import * as moveLegacyRecords from './0004_move_legacy_records.js';

// Every migration, oldest first. A static list because opening the store is synchronous and
// import() isn't. migrate.test.js checks it matches the NNNN_name.js files in this folder.

/** Builds `{ version, name, up }` from a file name like "0002_normalise_emails.js". */
function register(fileName, migrationModule) {
    const match = /^(\d{4})_(\w+)\.js$/.exec(fileName);
    return { version: Number(match[1]), name: match[2], up: migrationModule.up };
}

export const MIGRATIONS = [
    register('0001_baseline.js', baseline),
    register('0002_normalise_emails.js', normaliseEmails),
    register('0003_game_tables.js', gameTables),
    register('0004_move_legacy_records.js', moveLegacyRecords),
];
