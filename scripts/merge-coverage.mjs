// Merges lcov reports, writes the merged report plus a text summary, and enforces the
// per-area coverage targets in scripts/lcov/areas.mjs. Exits 1 when an area is below target
// (files below target are only warnings) and 2 when it can't run (bad arguments, missing report).
//
// Usage (paths relative to the current directory, which is also the root for SF: paths):
//   node scripts/merge-coverage.mjs --areas client --out coverage/merged coverage/node/lcov.info coverage/ui/lcov.info
//   node ../scripts/merge-coverage.mjs --areas server --out coverage/merged coverage/lcov.info   (from server/)

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { formatLcov, mergeRecords, parseLcov } from './lcov/lcov.mjs';
import { AREA_SETS, evaluateAreas, formatSummary, isExcludedFrom } from './lcov/areas.mjs';

const EXIT_BELOW_TARGET = 1;
const EXIT_USAGE = 2;

// --- Arguments ----------------------------------------------------------------

function fail(message) {
    console.error(`merge-coverage: ${message}`);
    process.exit(EXIT_USAGE);
}

function readOptions() {
    const { values, positionals } = parseArgs({
        options: {
            areas: { type: 'string' },
            out: { type: 'string', default: 'coverage/merged' },
        },
        allowPositionals: true,
    });

    if (!Object.hasOwn(AREA_SETS, values.areas ?? '')) {
        fail(`--areas must be one of: ${Object.keys(AREA_SETS).join(', ')}`);
    }
    if (positionals.length === 0) {
        fail('pass at least one lcov.info file');
    }
    for (const reportPath of positionals) {
        if (!fs.existsSync(reportPath)) {
            fail(`no report at ${reportPath}; run the coverage step that writes it first`);
        }
    }

    return { areaSetName: values.areas, outDir: values.out, reportPaths: positionals };
}

function readReport(reportPath, rootDir) {
    try {
        return parseLcov(fs.readFileSync(reportPath, 'utf8'), rootDir);
    } catch (error) {
        fail(`${reportPath}: ${error.message}`);
    }
}

// --- Main ---------------------------------------------------------------------

function main() {
    const { areaSetName, outDir, reportPaths } = readOptions();
    const rootDir = process.cwd();

    const records = [];
    for (const reportPath of reportPaths) {
        records.push(...readReport(reportPath, rootDir));
    }
    const merged = mergeRecords(records, (file) => isExcludedFrom(areaSetName, file));

    const evaluation = evaluateAreas(merged, AREA_SETS[areaSetName]);
    const summary = formatSummary(evaluation);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'lcov.info'), formatLcov(merged));
    fs.writeFileSync(path.join(outDir, 'summary.txt'), summary);

    console.log(summary);
    console.log(`Merged ${reportPaths.length} report(s), ${merged.length} files -> ${path.join(outDir, 'lcov.info')}`);

    const someAreaFails = evaluation.areas.some((result) => !result.passes);
    if (someAreaFails) {
        process.exitCode = EXIT_BELOW_TARGET;
    }
}

main();
