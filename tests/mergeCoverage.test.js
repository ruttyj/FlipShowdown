// Tests for the lcov merge and per-area coverage check (scripts/lcov/). Run with `npm test`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    countRecord,
    formatLcov,
    mergeRecords,
    normalizeSourcePath,
    parseLcov,
    selectRecordsToMerge,
} from '../scripts/lcov/lcov.mjs';
import {
    AREA_SETS,
    evaluateAreas,
    formatSummary,
    isExcludedFrom,
    percentage,
} from '../scripts/lcov/areas.mjs';

const ROOT = path.resolve('fake-root');

// --- Fixture builders ---------------------------------------------------------

/** Builds one lcov record. `lines` maps line -> hits; `branches` is [line, block, branch, hits]. */
function lcovRecord(file, { lines = {}, branches = [], placeholder = false } = {}) {
    const output = ['TN:', `SF:${file}`];
    if (placeholder) {
        output.push('FN:1,(empty-report)', 'FNF:1', 'FNH:0');
    }
    for (const [lineNumber, hits] of Object.entries(lines)) {
        output.push(`DA:${lineNumber},${hits}`);
    }
    for (const [lineNumber, block, branch, hits] of branches) {
        output.push(`BRDA:${lineNumber},${block},${branch},${hits}`);
    }
    output.push('end_of_record');
    return output.join('\n');
}

function parse(...records) {
    return parseLcov(records.join('\n'), ROOT);
}

/** A record for `file` with `found` lines of which the first `hit` ran, and the same for branches. */
function syntheticRecord(file, linesHit, linesFound, branchesHit = 0, branchesFound = 0) {
    const lines = new Map();
    for (let lineNumber = 1; lineNumber <= linesFound; lineNumber += 1) {
        lines.set(lineNumber, lineNumber <= linesHit ? 1 : 0);
    }
    const branches = [];
    for (let index = 0; index < branchesFound; index += 1) {
        branches.push({ line: 1, block: index, branch: 0, hits: index < branchesHit ? 1 : 0 });
    }
    return { file, lines, branches, isPlaceholder: false };
}

// --- Paths --------------------------------------------------------------------

test('relative Windows paths become forward-slash keys', () => {
    assert.equal(normalizeSourcePath('src\\lib\\a.js', ROOT), 'src/lib/a.js');
    assert.equal(normalizeSourcePath('./src/lib/a.js', ROOT), 'src/lib/a.js');
});

test('absolute paths are made relative to the root', () => {
    assert.equal(normalizeSourcePath(path.join(ROOT, 'src', 'lib', 'a.js'), ROOT), 'src/lib/a.js');
});

// --- Parsing ------------------------------------------------------------------

test('parsing reads lines, branches and the c8 placeholder marker', () => {
    const [record] = parse(lcovRecord('src\\lib\\a.js', {
        lines: { 1: 3, 2: 0 },
        branches: [[1, 0, 0, 2], [1, 0, 1, '-']],
        placeholder: true,
    }));

    assert.equal(record.file, 'src/lib/a.js');
    assert.deepEqual([...record.lines], [[1, 3], [2, 0]]);
    assert.equal(record.branches[1].hits, 0, 'a "-" branch count means never taken');
    assert.equal(record.isPlaceholder, true);
    assert.deepEqual(countRecord(record), { linesFound: 2, linesHit: 1, branchesFound: 2, branchesHit: 1 });
});

test('parsing accepts CRLF line endings and ignores summary lines', () => {
    const text = lcovRecord('src/a.js', { lines: { 1: 1 } }).replace('end_of_record', 'LF:99\nLH:99\nend_of_record');
    const [record] = parseLcov(text.split('\n').join('\r\n'), ROOT);

    assert.equal(record.file, 'src/a.js');
    assert.equal(countRecord(record).linesFound, 1);
});

// --- Merging lines ------------------------------------------------------------

test('a line counts as covered when either runner hit it', () => {
    const records = parse(
        lcovRecord('src/lib/a.js', { lines: { 1: 1, 2: 0, 3: 0 } }),
        lcovRecord('src\\lib\\a.js', { lines: { 1: 0, 2: 4, 3: 0 } }),
    );
    const [merged] = mergeRecords(records);

    assert.deepEqual(countRecord(merged), { linesFound: 3, linesHit: 2, branchesFound: 0, branchesHit: 0 });
});

test('an unexecuted record does not add phantom lines to an executed one', () => {
    // c8's placeholder lists every physical line (here 1-5) while Vitest lists code lines only.
    const records = parse(
        lcovRecord('src/pages/P.jsx', { lines: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, placeholder: true }),
        lcovRecord('src/pages/P.jsx', { lines: { 2: 1, 4: 0 } }),
    );
    const [merged] = mergeRecords(records);

    assert.deepEqual(countRecord(merged), { linesFound: 2, linesHit: 1, branchesFound: 0, branchesHit: 0 });
});

test('a file no runner executed keeps the real record over the c8 placeholder', () => {
    const placeholder = parse(lcovRecord('src/a.jsx', { lines: { 1: 0, 2: 0 }, placeholder: true }))[0];
    const larger = parse(lcovRecord('src/a.jsx', { lines: { 1: 0, 2: 0, 3: 0 } }))[0];
    const smaller = parse(lcovRecord('src/a.jsx', { lines: { 2: 0 } }))[0];

    assert.deepEqual(selectRecordsToMerge([placeholder, larger]), [larger]);
    assert.deepEqual(selectRecordsToMerge([larger, smaller]), [smaller]);
    assert.deepEqual(selectRecordsToMerge([placeholder]), [placeholder]);
});

test('files only one runner reported are kept as they are', () => {
    const records = parse(
        lcovRecord('src/lib/a.js', { lines: { 1: 1 } }),
        lcovRecord('src/lib/b.js', { lines: { 1: 0 } }),
    );

    assert.deepEqual(mergeRecords(records).map((record) => record.file), ['src/lib/a.js', 'src/lib/b.js']);
});

test('excluded files are dropped from the merge', () => {
    const records = parse(
        lcovRecord('src/components/ui/button.jsx', { lines: { 1: 0 } }),
        lcovRecord('src/lib/a.js', { lines: { 1: 1 } }),
    );
    const merged = mergeRecords(records, (file) => isExcludedFrom('client', file));

    assert.deepEqual(merged.map((record) => record.file), ['src/lib/a.js']);
});

// --- Merging branches ---------------------------------------------------------

test('branches come from the runner that proved the most of them taken', () => {
    // The runners number blocks differently, so the same key is not the same branch.
    const records = parse(
        lcovRecord('src/lib/a.js', { lines: { 1: 1 }, branches: [[1, 0, 0, 1], [2, 1, 0, 0], [3, 2, 0, 0]] }),
        lcovRecord('src/lib/a.js', { lines: { 1: 1 }, branches: [[1, 0, 0, 0], [2, 1, 0, 5], [3, 2, 0, 1]] }),
    );
    const [merged] = mergeRecords(records);

    assert.deepEqual(countRecord(merged), { linesFound: 1, linesHit: 1, branchesFound: 3, branchesHit: 2 });
});

test('on a tie in branches taken, the record reporting more branches wins', () => {
    const records = parse(
        lcovRecord('src/lib/a.js', { lines: { 1: 1 }, branches: [[1, 0, 0, 1]] }),
        lcovRecord('src/lib/a.js', { lines: { 1: 1 }, branches: [[1, 0, 0, 1], [1, 0, 1, 0]] }),
    );
    const [merged] = mergeRecords(records);

    assert.equal(countRecord(merged).branchesFound, 2);
});

// --- Writing ------------------------------------------------------------------

test('the merged lcov round-trips with recomputed totals', () => {
    const records = parse(lcovRecord('src/lib/a.js', { lines: { 2: 0, 1: 3 }, branches: [[1, 0, 0, 2]] }));
    const text = formatLcov(mergeRecords(records));

    assert.match(text, /SF:src\/lib\/a\.js\nDA:1,3\nDA:2,0\nLF:2\nLH:1\nBRDA:1,0,0,2\nBRF:1\nBRH:1\nend_of_record\n$/);
    assert.deepEqual(countRecord(parseLcov(text, ROOT)[0]), countRecord(records[0]));
});

// --- Areas --------------------------------------------------------------------

test('client files land in the right area, gameRoom hooks before pages', () => {
    const areaOf = (file) => AREA_SETS.client.find((area) => area.matches(file))?.name;

    assert.equal(areaOf('src/lib/roomState.js'), 'src/lib + src/api');
    assert.equal(areaOf('src/api/game.js'), 'src/lib + src/api');
    assert.equal(areaOf('shared/rules.js'), 'shared');
    assert.equal(areaOf('src/hooks/useVote.js'), 'src/hooks + gameRoom/use*.js');
    assert.equal(areaOf('src/pages/gameRoom/useGameRoom.js'), 'src/hooks + gameRoom/use*.js');
    assert.equal(areaOf('src/pages/gameRoom/JoinScreen.jsx'), 'src/components/game + src/pages');
    assert.equal(areaOf('src/components/game/Scoreboard.jsx'), 'src/components/game + src/pages');
    assert.equal(areaOf('src/App.jsx'), undefined);
});

test('the §2 exclusions and leftovers are excluded from the client report', () => {
    for (const file of [
        'src/components/ui/button.jsx',
        'src/lib/utils.js',
        'src/hooks/use-mobile.jsx',
        'src/main.jsx',
        'src/utils/index.ts',
        'src/types/browser-globals.d.ts',
    ]) {
        assert.equal(isExcludedFrom('client', file), true, file);
    }
    assert.equal(isExcludedFrom('client', 'src/lib/roomState.js'), false);
});

test('an area with nothing to cover counts as fully covered', () => {
    assert.equal(percentage(0, 0), 100);
    assert.equal(percentage(1, 4), 25);
});

test('an area passes on its totals even when one file is below target', () => {
    const records = [
        syntheticRecord('src/lib/good.js', 199, 200, 40, 40),
        syntheticRecord('src/lib/weak.js', 9, 10, 1, 2),
    ];
    const { areas } = evaluateAreas(records, AREA_SETS.client);
    const libArea = areas.find((result) => result.area.name === 'src/lib + src/api');

    assert.equal(libArea.linesHit, 208);
    assert.equal(libArea.linesFound, 210);
    assert.equal(libArea.passes, true, '208/210 lines and 41/42 branches meet 98/95');
    assert.deepEqual(libArea.filesBelowTarget.map((entry) => entry.file), ['src/lib/weak.js']);
});

test('an area below target fails, and its files are listed worst first', () => {
    const records = [
        syntheticRecord('src/components/game/A.jsx', 79, 100),
        syntheticRecord('src/components/game/B.jsx', 10, 100),
    ];
    const { areas } = evaluateAreas(records, AREA_SETS.client);
    const gameArea = areas.find((result) => result.area.name === 'src/components/game + src/pages');

    assert.equal(gameArea.passes, false);
    assert.deepEqual(gameArea.filesBelowTarget.map((entry) => entry.file), [
        'src/components/game/B.jsx',
        'src/components/game/A.jsx',
    ]);
});

test('files in no area are reported for information and never fail', () => {
    const evaluation = evaluateAreas([syntheticRecord('src/App.jsx', 0, 10)], AREA_SETS.client);

    assert.equal(evaluation.other.linesFound, 10);
    assert.equal(evaluation.other.passes, true);
    const requiredAreas = evaluation.areas.filter((result) => !result.area.optional);
    assert.ok(requiredAreas.every((result) => !result.passes), 'required areas without files fail');
});

test('the desktop area is desktop/src/main, judged at 98/95', () => {
    const { areas } = evaluateAreas([syntheticRecord('desktop/src/main/tunnel.js', 97, 100, 10, 10)], AREA_SETS.client);
    const desktopArea = areas.find((result) => result.area.name === 'desktop/src/main');

    assert.equal(desktopArea.fileCount, 1);
    assert.equal(desktopArea.passes, false);
});

test('the launcher renderer is desktop/src/renderer, judged at 80/70 like the components', () => {
    const { areas } = evaluateAreas([syntheticRecord('desktop/src/renderer/HomeScreen.jsx', 79, 100, 10, 10)], AREA_SETS.client);
    const rendererArea = areas.find((result) => result.area.name === 'desktop/src/renderer');

    assert.equal(rendererArea.fileCount, 1);
    assert.equal(rendererArea.passes, false);
});

test("the launcher renderer's entry point is excluded like the app's", () => {
    assert.equal(isExcludedFrom('client', 'desktop/src/renderer/main.jsx'), true);
    assert.equal(isExcludedFrom('client', 'desktop/src/renderer/HomeScreen.jsx'), false);
});

test('an optional area with 0 files is skipped, not failed', () => {
    const evaluation = evaluateAreas([syntheticRecord('src/lib/a.js', 100, 100)], AREA_SETS.client);
    const desktopArea = evaluation.areas.find((result) => result.area.name === 'desktop/src/main');

    assert.equal(desktopArea.passes, true);
    assert.match(formatSummary(evaluation), /SKIP {2}desktop\/src\/main: no measured files yet/);
});

test('the server area is server/src, judged at 98/95', () => {
    const { areas } = evaluateAreas([syntheticRecord('src/index.js', 97, 100, 10, 10)], AREA_SETS.server);

    assert.equal(areas[0].passes, false);
    assert.match(formatSummary({ areas, other: evaluateAreas([], []).other }), /FAIL {2}server\/src: lines 97\.00% \(97\/100, target 98%\)/);
});

test('the summary shows PASS or FAIL per area and lists files below target as warnings', () => {
    const summary = formatSummary(evaluateAreas([
        syntheticRecord('src/lib/a.js', 100, 100),
        syntheticRecord('src/hooks/useX.js', 50, 100),
    ], AREA_SETS.client));

    assert.match(summary, /PASS {2}src\/lib \+ src\/api: lines 100\.00%/);
    assert.match(summary, /FAIL {2}src\/hooks \+ gameRoom\/use\*\.js: lines 50\.00%/);
    assert.match(summary, /warning: 1 file\(s\) in src\/hooks \+ gameRoom\/use\*\.js below target:\n {4}src\/hooks\/useX\.js {2}lines 50\.00%, branches 100\.00%/);
});

// --- Empty or truncated reports (final review) ---------------------------------

test('an area with 0 files fails and says so in the summary', () => {
    const evaluation = evaluateAreas([syntheticRecord('src/lib/a.js', 100, 100)], AREA_SETS.client);
    const hooksArea = evaluation.areas.find((result) => result.area.name === 'src/hooks + gameRoom/use*.js');

    assert.equal(hooksArea.passes, false);
    assert.match(formatSummary(evaluation), /FAIL {2}src\/hooks \+ gameRoom\/use\*\.js: no files in the report/);
});

test('an empty lcov input is rejected', () => {
    assert.throws(() => parseLcov('', ROOT), /no files/);
    assert.throws(() => parseLcov('\n\n', ROOT), /no files/);
});

test('a truncated lcov input is rejected', () => {
    const truncated = lcovRecord('src/lib/a.js', { lines: { 1: 1 } }).replace('end_of_record', '');

    assert.throws(() => parseLcov(truncated, ROOT), /truncated.*src\/lib\/a\.js/);
});

function runMergeCli(lcovText) {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-coverage-'));
    try {
        fs.writeFileSync(path.join(workDir, 'lcov.info'), lcovText);
        const script = path.resolve('scripts/merge-coverage.mjs');
        return spawnSync(process.execPath, [script, '--areas', 'server', '--out', 'out', 'lcov.info'], {
            cwd: workDir,
            encoding: 'utf8',
        });
    } finally {
        fs.rmSync(workDir, { recursive: true, force: true });
    }
}

test('merge-coverage exits non-zero with a clear message on an empty or truncated report', () => {
    const empty = runMergeCli('');
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /lcov\.info: the report lists no files/);

    const truncated = runMergeCli(lcovRecord('src/a.js', { lines: { 1: 1 } }).replace('end_of_record', ''));
    assert.equal(truncated.status, 2);
    assert.match(truncated.stderr, /lcov\.info: the report is truncated/);
});

test('merge-coverage exits non-zero when a whole area has no files', () => {
    const outsideServerSrc = runMergeCli(lcovRecord('lib/a.js', { lines: { 1: 1 } }));

    assert.equal(outsideServerSrc.status, 1);
    assert.match(outsideServerSrc.stdout, /FAIL {2}server\/src: no files in the report/);
});

// --- Line union for files both runners ran -------------------------------------

test('lines only one runner lists are dropped when both runners ran the file', () => {
    // c8 also lists comment and inner lines (3, 5) with 0 hits; Vitest lists code lines only.
    const records = parse(
        lcovRecord('src/lib/a.js', { lines: { 1: 1, 2: 1, 3: 0, 4: 0, 5: 0 } }),
        lcovRecord('src/lib/a.js', { lines: { 1: 1, 2: 0, 4: 3 } }),
    );
    const [merged] = mergeRecords(records);

    assert.deepEqual([...merged.lines], [[1, 2], [2, 1], [4, 3]]);
    assert.deepEqual(countRecord(merged), { linesFound: 3, linesHit: 3, branchesFound: 0, branchesHit: 0 });
});
