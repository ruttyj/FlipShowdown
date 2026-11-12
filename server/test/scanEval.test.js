import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
    compareHand,
    evaluateModel,
    formatReport,
    parseLabelledFilename,
    runCli,
    summariseModel,
} from '../eval/scanEval.js';
import { readImageSize } from '../eval/imageSize.js';
import { GeminiError } from '../src/gemini.js';

// The eval script is run by hand with real photos. These tests cover everything but the real call,
// so the numbers it reports can be trusted. Nothing here reaches the network.

const LUCKY_13 = { value: '13', type: 'special' };
const UNLUCKY_7 = { value: '7', type: 'special' };
const THE_ZERO = { value: '0', type: 'special' };
const PLAIN_13 = { value: '13', type: 'number' };
const PLAIN_5 = { value: '5', type: 'number' };
const MINUS_4 = { value: '-4', type: 'subtractor' };

// --- Image bytes ---------------------------------------------------------

// Only the headers: the eval reads a photo's size and never decodes it.

/** A JPEG with an APP0 segment before the frame header, as a camera writes one. */
function jpegBytes(width, height, { sizeInBytes = 0 } = {}) {
    const start = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const frame = [0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x11, 0x00, 0x00];
    const header = Buffer.from([...start, ...frame]);
    return Buffer.concat([header, Buffer.alloc(Math.max(0, sizeInBytes - header.length))]);
}

function pngBytes(width, height) {
    const bytes = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
    bytes.writeUInt32BE(13, 8);
    bytes.write('IHDR', 12, 'latin1');
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);
    return bytes;
}

function webpBytes(chunk, payload) {
    const bytes = Buffer.alloc(20 + payload.length);
    bytes.write('RIFF', 0, 'latin1');
    bytes.write('WEBP', 8, 'latin1');
    bytes.write(chunk, 12, 'latin1');
    payload.copy(bytes, 20);
    return bytes;
}

/** Lossy: a frame tag, a start code, then 14-bit sizes. */
function webpLossy(width, height) {
    const payload = Buffer.alloc(10);
    Buffer.from([0x9d, 0x01, 0x2a]).copy(payload, 3);
    payload.writeUInt16LE(width, 6);
    payload.writeUInt16LE(height, 8);
    return webpBytes('VP8 ', payload);
}

/** Lossless: a signature byte, then 14 bits each for width - 1 and height - 1. */
function webpLossless(width, height) {
    const payload = Buffer.alloc(5);
    payload[0] = 0x2f;
    payload.writeUInt32LE((((height - 1) << 14) | (width - 1)) >>> 0, 1);
    return webpBytes('VP8L', payload);
}

/** Extended: flags and padding, then 24 bits each for width - 1 and height - 1. */
function webpExtended(width, height) {
    const payload = Buffer.alloc(10);
    payload.writeUIntLE(width - 1, 4, 3);
    payload.writeUIntLE(height - 1, 7, 3);
    return webpBytes('VP8X', payload);
}

describe('readImageSize', () => {
    test('reads each format, with each dimension the right way round', () => {
        assert.deepEqual(readImageSize(jpegBytes(4032, 3024), 'image/jpeg'), { width: 4032, height: 3024 });
        assert.deepEqual(readImageSize(pngBytes(800, 1024), 'image/png'), { width: 800, height: 1024 });
        assert.deepEqual(readImageSize(webpLossy(1000, 600), 'image/webp'), { width: 1000, height: 600 });
        assert.deepEqual(readImageSize(webpLossless(1000, 600), 'image/webp'), { width: 1000, height: 600 });
        assert.deepEqual(readImageSize(webpExtended(1000, 600), 'image/webp'), { width: 1000, height: 600 });
    });

    test('a progressive JPEG has its size in a different frame header', () => {
        const bytes = jpegBytes(640, 480);
        bytes[9] = 0xc2;

        assert.deepEqual(readImageSize(bytes, 'image/jpeg'), { width: 640, height: 480 });
    });

    test('a Huffman table segment is not mistaken for a frame header', () => {
        const table = Buffer.from([0xff, 0xd8, 0xff, 0xc4, 0x00, 0x08, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]);
        const bytes = Buffer.concat([table, jpegBytes(640, 480).subarray(2)]);

        assert.deepEqual(readImageSize(bytes, 'image/jpeg'), { width: 640, height: 480 });
    });

    test('anything else is null, rather than a guess', () => {
        assert.equal(readImageSize(Buffer.from('fake jpeg bytes'), 'image/jpeg'), null);
        assert.equal(readImageSize(Buffer.from('fake png bytes'), 'image/png'), null);
        assert.equal(readImageSize(Buffer.from('fake webp bytes'), 'image/webp'), null);
        assert.equal(readImageSize(jpegBytes(640, 480).subarray(0, 12), 'image/jpeg'), null);
        assert.equal(readImageSize(pngBytes(640, 480), 'image/jpeg'), null);
        assert.equal(readImageSize(webpBytes('ALPH', Buffer.alloc(10)), 'image/webp'), null);
        assert.equal(readImageSize(Buffer.alloc(0), 'image/bmp'), null);
    });
});

// --- Filenames -----------------------------------------------------------

describe('parseLabelledFilename', () => {
    test('reads the plan\'s example', () => {
        assert.deepEqual(parseLabelledFilename('lucky13_13_5_minus4.jpg'), {
            cards: [LUCKY_13, PLAIN_13, PLAIN_5, MINUS_4],
            unknownTokens: [],
        });
    });

    test('reads every card in the deck', () => {
        const { cards, unknownTokens } = parseLabelledFilename(
            'zero_unlucky7_lucky13_div2_minus2_minus4_minus6_minus8_minus10_1_12.png',
        );

        assert.deepEqual(unknownTokens, []);
        assert.deepEqual(cards, [
            THE_ZERO,
            UNLUCKY_7,
            LUCKY_13,
            { value: '÷2', type: 'divisor' },
            { value: '-2', type: 'subtractor' },
            MINUS_4,
            { value: '-6', type: 'subtractor' },
            { value: '-8', type: 'subtractor' },
            { value: '-10', type: 'subtractor' },
            { value: '1', type: 'number' },
            { value: '12', type: 'number' },
        ]);
    });

    test('keeps repeated cards, as a duplicate has to be read twice', () => {
        assert.deepEqual(parseLabelledFilename('13_13.jpg').cards, [PLAIN_13, PLAIN_13]);
    });

    test('an action card in frame or an empty table expects no card', () => {
        assert.deepEqual(parseLabelledFilename('5_action.webp').cards, [PLAIN_5]);
        assert.deepEqual(parseLabelledFilename('none.jpeg').cards, []);
    });

    test('ignores case, and a note after two underscores tells apart photos of one hand', () => {
        assert.deepEqual(parseLabelledFilename('LUCKY13_5__sideways_fan.JPG').cards, [LUCKY_13, PLAIN_5]);
    });

    test('takes a full path', () => {
        assert.deepEqual(parseLabelledFilename(path.join('photos', 'set 1', '5.jpg')).cards, [PLAIN_5]);
    });

    test('reports what it cannot read rather than guessing', () => {
        const { cards, unknownTokens } = parseLabelledFilename('5_x2_plus4_0_14_lucky7.jpg');

        assert.deepEqual(cards, [PLAIN_5]);
        assert.deepEqual(unknownTokens, ['x2', 'plus4', '0', '14', 'lucky7']);
    });
});

// --- One photo -----------------------------------------------------------

describe('compareHand', () => {
    test('the same cards in another order are an exact match', () => {
        const comparison = compareHand([PLAIN_5, MINUS_4], [MINUS_4, PLAIN_5]);

        assert.equal(comparison.isExact, true);
        assert.deepEqual(comparison.falseSpecials, []);
        assert.deepEqual(comparison.tallies, [
            { card: PLAIN_5, truePositives: 1, falsePositives: 0, falseNegatives: 0 },
            { card: MINUS_4, truePositives: 1, falsePositives: 0, falseNegatives: 0 },
        ]);
    });

    test('a missing duplicate is a miss, not a match', () => {
        const comparison = compareHand([PLAIN_13, PLAIN_13], [PLAIN_13]);

        assert.equal(comparison.isExact, false);
        assert.deepEqual(comparison.tallies, [
            { card: PLAIN_13, truePositives: 1, falsePositives: 0, falseNegatives: 1 },
        ]);
    });

    test('a plain 13 read as Lucky 13 is flagged as a false special', () => {
        const comparison = compareHand([PLAIN_13], [LUCKY_13]);

        assert.equal(comparison.isExact, false);
        assert.deepEqual(comparison.falseSpecials, [LUCKY_13]);
        assert.deepEqual(comparison.tallies, [
            { card: PLAIN_13, truePositives: 0, falsePositives: 0, falseNegatives: 1 },
            { card: LUCKY_13, truePositives: 0, falsePositives: 1, falseNegatives: 0 },
        ]);
    });

    test('a real special isn\'t flagged, and a Lucky 13 read as plain isn\'t a false special', () => {
        assert.deepEqual(compareHand([LUCKY_13], [LUCKY_13]).falseSpecials, []);
        assert.deepEqual(compareHand([LUCKY_13], [PLAIN_13]).falseSpecials, []);
    });

    test('a second special beyond the one in the hand is flagged once', () => {
        assert.deepEqual(compareHand([UNLUCKY_7], [UNLUCKY_7, UNLUCKY_7]).falseSpecials, [UNLUCKY_7]);
    });

    test('two empty hands are an exact match', () => {
        assert.equal(compareHand([], []).isExact, true);
    });
});

// --- One model -----------------------------------------------------------

describe('summariseModel', () => {
    const photos = [
        { file: 'a.jpg', expected: [PLAIN_5, MINUS_4], predicted: [PLAIN_5, MINUS_4] },
        { file: 'b.jpg', expected: [PLAIN_13, PLAIN_5], predicted: [LUCKY_13, PLAIN_5] },
        { file: 'c.jpg', expected: [THE_ZERO], predicted: [], error: 'Gemini responded with 500' },
    ];

    test('counts photos, cards, false specials and failures', () => {
        const summary = summariseModel('flash-lite', photos);

        assert.equal(summary.model, 'flash-lite');
        assert.equal(summary.photoCount, 3);
        assert.equal(summary.exactCount, 1);
        assert.equal(summary.exactRate, 1 / 3);
        assert.deepEqual(summary.falseSpecials, [{ file: 'b.jpg', card: LUCKY_13 }]);
        assert.deepEqual(summary.failures, [{ file: 'c.jpg', error: 'Gemini responded with 500' }]);
        assert.equal(summary.meetsTarget, false);

        // Three of the four cards predicted were right, and three of the five in the photos were found.
        assert.equal(summary.overall.precision, 3 / 4);
        assert.equal(summary.overall.recall, 3 / 5);
    });

    test('gives each card its own precision and recall', () => {
        const { perCard } = summariseModel('flash-lite', photos);
        const byName = new Map(perCard.map((row) => [row.name, row]));

        assert.deepEqual(byName.get('5'), {
            name: '5', truePositives: 2, falsePositives: 0, falseNegatives: 0, precision: 1, recall: 1,
        });
        assert.deepEqual(byName.get('Lucky 13'), {
            name: 'Lucky 13', truePositives: 0, falsePositives: 1, falseNegatives: 0, precision: 0, recall: null,
        });
        assert.deepEqual(byName.get('The Zero'), {
            name: 'The Zero', truePositives: 0, falsePositives: 0, falseNegatives: 1, precision: null, recall: 0,
        });
    });

    test('meets the target at 95% exact with no false specials', () => {
        const nineteenRight = Array.from({ length: 19 }, (_, index) => (
            { file: `${index}.jpg`, expected: [PLAIN_5], predicted: [PLAIN_5] }
        ));
        const oneWrong = { file: 'wrong.jpg', expected: [PLAIN_5], predicted: [] };
        const oneFalseSpecial = { file: 'special.jpg', expected: [PLAIN_13], predicted: [LUCKY_13] };

        assert.equal(summariseModel('m', [...nineteenRight, oneWrong]).meetsTarget, true);
        assert.equal(summariseModel('m', [...nineteenRight, oneFalseSpecial]).meetsTarget, false);
        assert.equal(summariseModel('m', nineteenRight.slice(0, 1).concat(oneWrong)).meetsTarget, false);
    });

    test('a failed call on a photo that expects no card is not exact', () => {
        for (const file of ['action.jpg', 'none.jpg']) {
            const failed = { file, expected: [], predicted: [], error: 'Gemini responded with 500' };

            const summary = summariseModel('m', [failed]);

            assert.equal(summary.exactCount, 0);
            assert.equal(summary.exactRate, 0);
            assert.deepEqual(summary.failures, [{ file, error: 'Gemini responded with 500' }]);
            assert.equal(summary.meetsTarget, false);
        }
    });

    test('a photo that expects no card and reads none is still exact', () => {
        const summary = summariseModel('m', [{ file: 'none.jpg', expected: [], predicted: [] }]);

        assert.equal(summary.exactCount, 1);
        assert.equal(summary.meetsTarget, true);
    });

    test('any failure misses the target, even with 95% of the photos exactly right', () => {
        const nineteenRight = Array.from({ length: 19 }, (_, index) => (
            { file: `${index}.jpg`, expected: [PLAIN_5], predicted: [PLAIN_5] }
        ));
        const failed = { file: 'failed.jpg', expected: [PLAIN_5], predicted: [], error: 'Unreadable answer' };

        const summary = summariseModel('m', [...nineteenRight, failed]);

        assert.equal(summary.exactRate, 0.95);
        assert.equal(summary.meetsTarget, false);
        assert.match(formatReport(summary), /Target not met/);
    });

    test('no photos meets no target and divides by nothing', () => {
        const summary = summariseModel('m', []);

        assert.equal(summary.exactRate, null);
        assert.equal(summary.meetsTarget, false);
    });
});

describe('formatReport', () => {
    test('names the model, the rates, each card and every false special', () => {
        const report = formatReport(summariseModel('flash-lite', [
            { file: 'a.jpg', expected: [PLAIN_5], predicted: [PLAIN_5] },
            { file: 'b.jpg', expected: [PLAIN_13], predicted: [LUCKY_13] },
            { file: 'c.jpg', expected: [THE_ZERO], predicted: [], error: 'boom' },
        ]));

        assert.match(report, /flash-lite/);
        assert.match(report, /Photos exactly right: 1 of 3 \(33\.3%\)/);
        assert.match(report, /Lucky 13/);
        assert.match(report, /n\/a/);
        assert.match(report, /FALSE SPECIAL: b\.jpg read Lucky 13/);
        assert.match(report, /FAILED: c\.jpg: boom/);
        assert.match(report, /Target not met/);
    });

    test('says when there are no false specials and the target is met', () => {
        const report = formatReport(summariseModel('m', [{ file: 'a.jpg', expected: [PLAIN_5], predicted: [PLAIN_5] }]));

        assert.match(report, /False specials: none/);
        assert.match(report, /Target met/);
        assert.doesNotMatch(report, /FAILED/);
    });

    test('a run with no photos reads as n/a', () => {
        assert.match(formatReport(summariseModel('m', [])), /0 of 0 \(n\/a\)/);
    });
});

// --- Running a model -----------------------------------------------------

describe('evaluateModel', () => {
    const photo = { file: '13_5.jpg', expected: [PLAIN_13, PLAIN_5], image: { mimeType: 'image/jpeg', base64: 'AAAA' } };

    test('sends the Vengeance prompt and maps the answer as the server does', async () => {
        const requests = [];
        const client = {
            generateJson: async (request) => {
                requests.push(request);
                return { visible_card_count: 2, cards: [{ printed_text: 'x', label: 'LUCKY_13' }, { printed_text: 'x', label: 'ACTION' }] };
            },
        };

        const [result] = await evaluateModel({ client, model: 'gemini-x', photos: [photo] });

        assert.equal(requests[0].model, 'gemini-x');
        assert.deepEqual(requests[0].image, photo.image);
        assert.match(requests[0].prompt, /YOU MAY HAVE ONE OTHER 13/);
        assert.ok(requests[0].schema);
        assert.deepEqual(result, { file: '13_5.jpg', expected: photo.expected, predicted: [LUCKY_13] });
    });

    test('a failed call counts as a photo with nothing read, and the run carries on', async () => {
        const answers = [
            () => {
                throw new GeminiError('Gemini responded with 500', 500);
            },
            () => ({ notCards: true }),
            () => ({ cards: [] }),
        ];
        const client = { generateJson: async () => answers.shift()() };

        const results = await evaluateModel({ client, model: 'm', photos: [photo, photo, photo] });

        assert.equal(results[0].error, 'Gemini responded with 500');
        assert.deepEqual(results[0].predicted, []);
        assert.equal(results[1].error, 'Unreadable answer');
        assert.equal(results[2].error, undefined);
    });

    test('a bug in the script is not hidden as a failed photo', async () => {
        const client = {
            generateJson: async () => {
                throw new TypeError('a bug');
            },
        };

        await assert.rejects(evaluateModel({ client, model: 'm', photos: [photo] }), TypeError);
    });
});

// --- The command line ----------------------------------------------------

describe('runCli', () => {
    let photosDir;

    before(() => {
        photosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-scan-eval-'));
        fs.writeFileSync(path.join(photosDir, 'lucky13_5.jpg'), jpegBytes(1024, 768));
        fs.writeFileSync(path.join(photosDir, '13__fanned.png'), pngBytes(768, 1024));
        fs.writeFileSync(path.join(photosDir, 'notes.txt'), 'not a photo');
    });

    after(() => {
        fs.rmSync(photosDir, { recursive: true, force: true });
    });

    function geminiAnswer(cards) {
        const body = { candidates: [{ content: { parts: [{ text: JSON.stringify({ cards }) }] } }] };
        return new Response(JSON.stringify(body), { status: 200 });
    }

    function makeRun({ args, env = { GEMINI_API_KEY: 'test-key' }, answer = () => geminiAnswer([]) }) {
        const lines = [];
        const calls = [];
        const fetchImpl = async (url, init) => {
            calls.push({ url: String(url), body: JSON.parse(init.body) });
            return answer();
        };
        return { lines, calls, run: () => runCli({ args, env, fetchImpl, log: (line) => lines.push(line) }) };
    }

    test('runs each photo through each model and reports per model', async () => {
        const { lines, calls, run } = makeRun({
            args: ['--photos', photosDir, '--models', 'gemini-a,gemma-4-31b-it'],
            answer: () => geminiAnswer([{ printed_text: 'x', label: 'N_13' }]),
        });

        assert.equal(await run(), 0);

        const report = lines.join('\n');
        assert.equal(calls.length, 4);
        assert.match(report, /gemini-a/);
        assert.match(report, /gemma-4-31b-it/);
        assert.match(report, /Photos exactly right: 1 of 2/);

        const mimeTypes = calls.map((call) => call.body.contents[0].parts[0].inlineData.mimeType).sort();
        assert.deepEqual(mimeTypes, ['image/jpeg', 'image/jpeg', 'image/png', 'image/png']);
    });

    test('Gemma goes down the format-instruction path', async () => {
        const { calls, run } = makeRun({ args: ['--photos', photosDir, '--models', 'gemma-4-31b-it'] });

        await run();

        assert.equal(calls[0].body.generationConfig, undefined);
        assert.match(calls[0].body.contents[0].parts[1].text, /Answer with only a JSON object/);
    });

    test('refuses to run without its arguments or a key, before any call', async () => {
        const noPhotos = makeRun({ args: ['--models', 'm'] });
        const noModels = makeRun({ args: ['--photos', photosDir] });
        const noKey = makeRun({ args: ['--photos', photosDir, '--models', 'm'], env: {} });
        const badFlag = makeRun({ args: ['--nonsense'] });

        for (const attempt of [noPhotos, noModels, noKey, badFlag]) {
            assert.equal(await attempt.run(), 1);
            assert.equal(attempt.calls.length, 0);
            assert.match(attempt.lines.join('\n'), /Usage|GEMINI_API_KEY/);
        }
    });

    test('a badly named photo stops the run before spending any quota', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-scan-eval-bad-'));
        fs.writeFileSync(path.join(dir, 'lucky7_5.jpg'), 'x');

        try {
            const { lines, calls, run } = makeRun({ args: ['--photos', dir, '--models', 'm'] });

            assert.equal(await run(), 1);
            assert.equal(calls.length, 0);
            assert.match(lines.join('\n'), /lucky7_5\.jpg: lucky7/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    /** Runs the CLI over a new folder holding `files`, and removes it after. */
    async function runInFolder(files, { flags = [] } = {}) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-scan-eval-size-'));
        for (const [name, bytes] of Object.entries(files)) {
            fs.writeFileSync(path.join(dir, name), bytes);
        }

        try {
            const { lines, calls, run } = makeRun({ args: ['--photos', dir, '--models', 'm', ...flags] });
            const exitCode = await run();
            return { exitCode, calls, output: lines.join('\n') };
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    }

    test('a photo over the 1024 px the app sends stops the run before any call, and names the fix', async () => {
        const { exitCode, calls, output } = await runInFolder({
            '5.jpg': jpegBytes(1024, 768),
            '13.jpg': jpegBytes(4032, 3024),
            '7.png': pngBytes(800, 1600),
        });

        assert.equal(exitCode, 1);
        assert.equal(calls.length, 0);
        assert.match(output, /13\.jpg: 4032 x 3024/);
        assert.match(output, /7\.png: 800 x 1600/);
        assert.doesNotMatch(output, /5\.jpg/);
        assert.match(output, /1024/);
    });

    test('a photo exactly at the limit runs', async () => {
        const { exitCode, calls } = await runInFolder({ '5.jpg': jpegBytes(1024, 1024) });

        assert.equal(exitCode, 0);
        assert.equal(calls.length, 1);
    });

    test('--max-edge raises the limit, for the "raise the resize limit" step', async () => {
        const photos = { '5.jpg': jpegBytes(1600, 1200) };

        const atDefault = await runInFolder(photos);
        const raised = await runInFolder(photos, { flags: ['--max-edge', '1600'] });
        const tooLowStill = await runInFolder(photos, { flags: ['--max-edge', '1599'] });

        assert.equal(atDefault.exitCode, 1);
        assert.equal(raised.exitCode, 0);
        assert.equal(raised.calls.length, 1);
        assert.equal(tooLowStill.exitCode, 1);
        assert.match(tooLowStill.output, /1599/);
    });

    test('a --max-edge that is not a positive whole number is a usage error', async () => {
        for (const bad of ['0', '-5', '10.5', 'big', '']) {
            const photos = { '5.jpg': jpegBytes(100, 100) };

            const { exitCode, calls, output } = await runInFolder(photos, { flags: ['--max-edge', bad] });

            assert.equal(exitCode, 1);
            assert.equal(calls.length, 0);
            assert.match(output, /Usage/);
        }
    });

    test('a photo over the server\'s 4 MB cap stops the run, as the app could never send it', async () => {
        const { exitCode, calls, output } = await runInFolder({
            '5.jpg': jpegBytes(1024, 768, { sizeInBytes: 4 * 1024 * 1024 + 1 }),
        });

        assert.equal(exitCode, 1);
        assert.equal(calls.length, 0);
        assert.match(output, /5\.jpg: .*4 MB/);
    });

    test('a photo of exactly 4 MB runs', async () => {
        const { exitCode } = await runInFolder({ '5.jpg': jpegBytes(1024, 768, { sizeInBytes: 4 * 1024 * 1024 }) });

        assert.equal(exitCode, 0);
    });

    test('a file whose size can\'t be read stops the run, rather than going up unchecked', async () => {
        const { exitCode, calls, output } = await runInFolder({ '5.jpg': 'not really a jpeg' });

        assert.equal(exitCode, 1);
        assert.equal(calls.length, 0);
        assert.match(output, /5\.jpg/);
    });

    test('every photo problem is listed at once, so one pass fixes them all', async () => {
        const { output } = await runInFolder({
            'lucky7.jpg': jpegBytes(100, 100),
            '5.jpg': jpegBytes(2000, 100),
        });

        assert.match(output, /lucky7\.jpg: lucky7/);
        assert.match(output, /5\.jpg: 2000 x 100/);
    });

    test('a folder with no photos is an error', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flip7-scan-eval-empty-'));

        try {
            const { lines, run } = makeRun({ args: ['--photos', dir, '--models', 'm'] });

            assert.equal(await run(), 1);
            assert.match(lines.join('\n'), /No photos/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
