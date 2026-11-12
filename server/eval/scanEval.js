// Measures the Vengeance scan prompt against labelled photos. Run by hand, never by test:all, as it
// spends real Gemini quota. How to run it: docs/testing.md.
//
//   GEMINI_API_KEY=... node eval/scanEval.js --photos <folder> --models gemini-a,gemma-b
//
// A photo's name is its hand, so no other file is needed: lucky13_13_5_minus4.jpg. See
// parseLabelledFilename. The requests and the mapping are the server's own (src/scanModes.js).
//
// Photos go up as they are, while the app first shrinks them to a 1024 px long edge (CardScanner.jsx),
// so a run stops on a photo the app could never send. A full-size photo could pass here and miss in
// production. --max-edge moves the limit, to measure a larger resize before changing the app.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MAX_IMAGE_BYTES } from '../src/aiRoutes.js';
import { GeminiError, createGeminiClient } from '../src/gemini.js';
import { buildScanRequest, getScanMode, normaliseScanResult } from '../src/scanModes.js';
import { readImageSize } from './imageSize.js';

// The bar a scan prompt has to clear.
const TARGET_EXACT_RATE = 0.95;

// SCAN_IMAGE_MAX_SIZE in CardScanner.jsx.
const DEFAULT_MAX_EDGE = 1024;
const BYTES_PER_MB = 1024 * 1024;

const MIME_TYPES_BY_EXTENSION = new Map([
    ['.jpg', 'image/jpeg'],
    ['.jpeg', 'image/jpeg'],
    ['.png', 'image/png'],
    ['.webp', 'image/webp'],
]);

const USAGE = 'Usage: GEMINI_API_KEY=... node eval/scanEval.js --photos <folder> --models <model,model,...> [--max-edge <px>]';

// --- Photo names -----------------------------------------------------------

// Written out rather than taken from the server's mapping, so a mistake there shows up as a miss.
const CARDS_BY_TOKEN = new Map([
    ['zero', { value: '0', type: 'special' }],
    ['unlucky7', { value: '7', type: 'special' }],
    ['lucky13', { value: '13', type: 'special' }],
    ['div2', { value: '÷2', type: 'divisor' }],
    ['minus2', { value: '-2', type: 'subtractor' }],
    ['minus4', { value: '-4', type: 'subtractor' }],
    ['minus6', { value: '-6', type: 'subtractor' }],
    ['minus8', { value: '-8', type: 'subtractor' }],
    ['minus10', { value: '-10', type: 'subtractor' }],
]);

// In the photo, but no card should come back: an action card in frame, or an empty table.
const NO_CARD_TOKENS = new Set(['action', 'none']);

function isPlainNumberToken(token) {
    return /^([1-9]|1[0-3])$/.test(token);
}

/**
 * Reads a hand from a photo's name. Tokens are split by "_", and anything after "__" is a note, which
 * lets several photos show one hand. "lucky13_13_5_minus4.jpg" -> those four cards, and
 * "13_13__fanned.png" -> two plain 13s. There's no token for x2 or +N, as the deck has neither.
 *
 * @param {string} filename  a name or a path
 * @returns {{cards: {value: string, type: string}[], unknownTokens: string[]}}
 */
export function parseLabelledFilename(filename) {
    const parsed = path.parse(filename);
    const [hand] = parsed.name.toLowerCase().split('__');

    const cards = [];
    const unknownTokens = [];
    for (const token of hand.split('_')) {
        if (isPlainNumberToken(token)) {
            cards.push({ value: token, type: 'number' });
        } else if (CARDS_BY_TOKEN.has(token)) {
            cards.push(CARDS_BY_TOKEN.get(token));
        } else if (!NO_CARD_TOKENS.has(token)) {
            unknownTokens.push(token);
        }
    }
    return { cards, unknownTokens };
}

// --- Comparing one photo ---------------------------------------------------

function cardKey(card) {
    return `${card.type}:${card.value}`;
}

/** Each different card in `cards` with how many times it appears, in first-seen order. */
function countCards(cards) {
    const counts = new Map();
    for (const card of cards) {
        const key = cardKey(card);
        const existing = counts.get(key);
        if (existing) {
            existing.count += 1;
        } else {
            counts.set(key, { card, count: 1 });
        }
    }
    return counts;
}

/**
 * Compares a photo's real hand with what was read, as multisets: the order doesn't matter, but a
 * duplicate has to be read twice, since a dropped one hides a bust.
 *
 * falseSpecials has one entry per special card read beyond those really there. It's the worst failure
 * of this feature, as a false Lucky 13 saves a player who really busted.
 * A real special read as plain isn't one, as it shows up as a miss, and the player gets a one-tap fix.
 *
 * @returns {{isExact: boolean, falseSpecials: object[], tallies: {card: object, truePositives: number,
 *   falsePositives: number, falseNegatives: number}[]}}
 */
export function compareHand(expected, predicted) {
    const expectedCounts = countCards(expected);
    const predictedCounts = countCards(predicted);
    const tallies = [];
    const falseSpecials = [];

    for (const [key, { card, count }] of expectedCounts) {
        const predictedCount = predictedCounts.get(key)?.count ?? 0;
        tallies.push({
            card,
            truePositives: Math.min(count, predictedCount),
            falsePositives: Math.max(predictedCount - count, 0),
            falseNegatives: Math.max(count - predictedCount, 0),
        });
    }

    for (const [key, { card, count }] of predictedCounts) {
        if (!expectedCounts.has(key)) {
            tallies.push({ card, truePositives: 0, falsePositives: count, falseNegatives: 0 });
        }
    }

    for (const tally of tallies) {
        if (tally.card.type === 'special') {
            for (let extra = 0; extra < tally.falsePositives; extra++) {
                falseSpecials.push(tally.card);
            }
        }
    }

    const isExact = tallies.every((tally) => tally.falsePositives === 0 && tally.falseNegatives === 0);
    return { isExact, falseSpecials, tallies };
}

// --- Summarising one model -------------------------------------------------

/** Numerator over denominator, or null when there was nothing to measure. */
function ratio(numerator, denominator) {
    if (denominator === 0) {
        return null;
    }
    return numerator / denominator;
}

const SPECIAL_NAMES = new Map([['0', 'The Zero'], ['7', 'Unlucky 7'], ['13', 'Lucky 13']]);

function cardName(card) {
    if (card.type === 'special') {
        return SPECIAL_NAMES.get(card.value);
    }
    return card.value;
}

function withRates(name, counts) {
    return {
        name,
        ...counts,
        precision: ratio(counts.truePositives, counts.truePositives + counts.falsePositives),
        recall: ratio(counts.truePositives, counts.truePositives + counts.falseNegatives),
    };
}

/** Adds a tally to a running count, which it creates under `name` the first time. */
function addTally(countsByName, name, tally) {
    if (!countsByName.has(name)) {
        countsByName.set(name, { truePositives: 0, falsePositives: 0, falseNegatives: 0 });
    }
    const counts = countsByName.get(name);
    counts.truePositives += tally.truePositives;
    counts.falsePositives += tally.falsePositives;
    counts.falseNegatives += tally.falseNegatives;
}

/**
 * Totals one model's run. A photo the model failed on counts as nothing read, so it lowers recall and
 * the exact rate rather than disappearing from them. It is never exact, even when no card was expected,
 * as nothing was measured, and any failure misses the target for the same reason.
 *
 * @param {string} model
 * @param {{file: string, expected: object[], predicted: object[], error?: string}[]} photoResults
 */
export function summariseModel(model, photoResults) {
    const countsByName = new Map();
    const overallCounts = new Map();
    const falseSpecials = [];
    const failures = [];
    let exactCount = 0;

    for (const { file, expected, predicted, error } of photoResults) {
        const comparison = compareHand(expected, predicted);
        if (error) {
            failures.push({ file, error });
        } else if (comparison.isExact) {
            exactCount += 1;
        }
        for (const card of comparison.falseSpecials) {
            falseSpecials.push({ file, card });
        }
        for (const tally of comparison.tallies) {
            addTally(countsByName, cardName(tally.card), tally);
            addTally(overallCounts, 'overall', tally);
        }
    }

    const perCard = [];
    for (const [name, counts] of countsByName) {
        perCard.push(withRates(name, counts));
    }
    perCard.sort((first, second) => first.name.localeCompare(second.name, undefined, { numeric: true }));

    const emptyCounts = { truePositives: 0, falsePositives: 0, falseNegatives: 0 };
    const exactRate = ratio(exactCount, photoResults.length);
    const meetsTarget = exactRate !== null
        && exactRate >= TARGET_EXACT_RATE
        && falseSpecials.length === 0
        && failures.length === 0;
    return {
        model,
        photoCount: photoResults.length,
        exactCount,
        exactRate,
        overall: withRates('overall', overallCounts.get('overall') ?? emptyCounts),
        perCard,
        falseSpecials,
        failures,
        meetsTarget,
    };
}

// --- Report ----------------------------------------------------------------

function percent(rate) {
    if (rate === null) {
        return 'n/a';
    }
    return `${(rate * 100).toFixed(1)}%`;
}

function formatCardRow({ name, truePositives, falsePositives, falseNegatives, precision, recall }) {
    const counts = `right ${truePositives}, extra ${falsePositives}, missed ${falseNegatives}`;
    return `  ${name.padEnd(10)} precision ${percent(precision).padEnd(6)} recall ${percent(recall).padEnd(6)} (${counts})`;
}

/** @param {ReturnType<typeof summariseModel>} summary */
export function formatReport(summary) {
    const lines = [
        `=== ${summary.model} ===`,
        `Photos exactly right: ${summary.exactCount} of ${summary.photoCount} (${percent(summary.exactRate)})`,
        `All cards: precision ${percent(summary.overall.precision)}, recall ${percent(summary.overall.recall)}`,
    ];

    for (const row of summary.perCard) {
        lines.push(formatCardRow(row));
    }

    if (summary.falseSpecials.length === 0) {
        lines.push('False specials: none');
    }
    for (const { file, card } of summary.falseSpecials) {
        lines.push(`FALSE SPECIAL: ${file} read ${cardName(card)}`);
    }
    for (const { file, error } of summary.failures) {
        lines.push(`FAILED: ${file}: ${error}`);
    }

    const targetWords = `at least ${percent(TARGET_EXACT_RATE)} exact, no false specials and no failed calls`;
    lines.push(summary.meetsTarget ? `Target met: ${targetWords}` : `Target not met: ${targetWords}`);
    return lines.join('\n');
}

// --- Running ---------------------------------------------------------------

/** Reads one photo, turning a failed call into a result so one bad photo doesn't end a paid run. */
async function readPhoto({ client, model, photo, scanMode }) {
    const base = { file: photo.file, expected: photo.expected };

    let answer;
    try {
        answer = await client.generateJson(buildScanRequest(model, photo.image, scanMode));
    } catch (error) {
        if (!(error instanceof GeminiError)) {
            throw error;
        }
        return { ...base, predicted: [], error: error.message };
    }

    const predicted = normaliseScanResult(answer, scanMode);
    if (!predicted) {
        return { ...base, predicted: [], error: 'Unreadable answer' };
    }
    return { ...base, predicted };
}

/**
 * Runs every photo through one model, one at a time to stay inside rate limits. Always the Vengeance
 * scan, which Brutal shares.
 *
 * @param {{client: {generateJson: Function}, model: string,
 *   photos: {file: string, expected: object[], image: {mimeType: string, base64: string}}[]}} run
 */
export async function evaluateModel({ client, model, photos }) {
    const scanMode = getScanMode('vengeance');
    const results = [];
    for (const photo of photos) {
        results.push(await readPhoto({ client, model, photo, scanMode }));
    }
    return results;
}

// --- Command line ----------------------------------------------------------

const CLI_OPTIONS = {
    photos: { type: 'string' },
    models: { type: 'string' },
    'max-edge': { type: 'string' },
};

/** The --max-edge value in px, the default when it's left out, or null when it isn't a whole number. */
function parseMaxEdge(text) {
    if (text === undefined) {
        return DEFAULT_MAX_EDGE;
    }
    if (!/^[1-9]\d*$/.test(text)) {
        return null;
    }
    return Number(text);
}

/** Returns { photosDir, models, maxEdge }, or null when an argument is missing, unknown or invalid. */
function parseCliArgs(args) {
    let values;
    try {
        ({ values } = parseArgs({ args, options: CLI_OPTIONS }));
    } catch {
        return null;
    }

    const models = (values.models ?? '').split(',').filter((model) => model !== '');
    const maxEdge = parseMaxEdge(values['max-edge']);
    if (!values.photos || models.length === 0 || maxEdge === null) {
        return null;
    }
    return { photosDir: values.photos, models, maxEdge };
}

/**
 * Why the app couldn't send this photo as it is, or null when it could.
 *
 * @returns {string|null}
 */
function describeOversizedPhoto(bytes, mimeType, maxEdge) {
    if (bytes.length > MAX_IMAGE_BYTES) {
        const megabytes = (bytes.length / BYTES_PER_MB).toFixed(1);
        return `${megabytes} MB, over the server's ${MAX_IMAGE_BYTES / BYTES_PER_MB} MB cap`;
    }

    const size = readImageSize(bytes, mimeType);
    if (!size) {
        return `can't read its size, so it may not really be ${mimeType}`;
    }

    const longEdge = Math.max(size.width, size.height);
    if (longEdge > maxEdge) {
        return `${size.width} x ${size.height}, long edge over ${maxEdge} px`;
    }
    return null;
}

/** The photos in a folder with their hands, and what's wrong with any that can't go up. */
async function loadLabelledPhotos(photosDir, maxEdge) {
    const photos = [];
    const badNames = [];
    const badPhotos = [];

    const files = await fs.readdir(photosDir);
    for (const file of files.sort()) {
        const mimeType = MIME_TYPES_BY_EXTENSION.get(path.extname(file).toLowerCase());
        if (!mimeType) {
            continue;
        }

        const { cards, unknownTokens } = parseLabelledFilename(file);
        if (unknownTokens.length > 0) {
            badNames.push(`${file}: ${unknownTokens.join(', ')}`);
        }

        const bytes = await fs.readFile(path.join(photosDir, file));
        const problem = describeOversizedPhoto(bytes, mimeType, maxEdge);
        if (problem) {
            badPhotos.push(`${file}: ${problem}`);
        }

        photos.push({ file, expected: cards, image: { mimeType, base64: bytes.toString('base64') } });
    }
    return { photos, badNames, badPhotos };
}

/** Every reason not to start, so one pass over the folder fixes them all. Null when there are none. */
function describePhotoProblems({ badNames, badPhotos }, maxEdge) {
    const sections = [];
    if (badNames.length > 0) {
        sections.push(`Fix these photo names first:\n${badNames.join('\n')}`);
    }
    if (badPhotos.length > 0) {
        const fix = `Export these as they would reach the model: JPEG, quality 85, long edge at most ${maxEdge} px `
            + '(docs/testing.md):';
        sections.push(`${fix}\n${badPhotos.join('\n')}`);
    }
    if (sections.length === 0) {
        return null;
    }
    return sections.join('\n');
}

/**
 * The script itself, with what it touches passed in so it can run without Gemini.
 *
 * @param {{args: string[], env: object, fetchImpl?: Function, log: (line: string) => void}} options
 * @returns {Promise<number>} the exit code
 */
export async function runCli({ args, env, fetchImpl, log }) {
    const options = parseCliArgs(args);
    if (!options) {
        log(USAGE);
        return 1;
    }
    if (!env.GEMINI_API_KEY) {
        log(`GEMINI_API_KEY isn't set. ${USAGE}`);
        return 1;
    }

    const loaded = await loadLabelledPhotos(options.photosDir, options.maxEdge);
    // A typo would be counted against the model and a full-size photo would flatter it, and either way
    // the run has a real cost.
    const problems = describePhotoProblems(loaded, options.maxEdge);
    if (problems) {
        log(problems);
        return 1;
    }

    const { photos } = loaded;
    if (photos.length === 0) {
        log(`No photos in ${options.photosDir}`);
        return 1;
    }

    const client = createGeminiClient({ apiKey: env.GEMINI_API_KEY, fetchImpl });
    for (const model of options.models) {
        const results = await evaluateModel({ client, model, photos });
        log(formatReport(summariseModel(model, results)));
    }
    return 0;
}

const isRunDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isRunDirectly) {
    process.exitCode = await runCli({
        args: process.argv.slice(2),
        env: process.env,
        log: console.log,
    });
}
