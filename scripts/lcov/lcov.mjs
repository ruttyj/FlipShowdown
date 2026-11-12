// Reading, merging and writing lcov coverage reports.
//
// The client's coverage comes from two runners: c8 around `node --test` (pure logic) and
// Vitest (hooks and components). Both write lcov for the same source files, so a file's
// real coverage is the union of the two. Everything here is pure (strings in, objects out)
// so tests/mergeCoverage.test.js can exercise it without touching the disk.
//
// A parsed record looks like:
//   { file: 'src/lib/roomState.js',
//     lines: Map<lineNumber, hitCount>,
//     branches: [{ line, block, branch, hits }],
//     isPlaceholder: boolean }
// `isPlaceholder` marks c8's `--all` stand-in for a file no test loaded ("(empty-report)").

import path from 'node:path';

const PLACEHOLDER_FUNCTION = '(empty-report)';

// --- Paths --------------------------------------------------------------------

function toForwardSlashes(filePath) {
    return filePath.split('\\').join('/');
}

/**
 * Turns an lcov `SF:` path into a forward-slash path relative to `rootDir`, so the same file
 * gets the same key whichever runner (or OS) wrote it.
 * Examples (Windows, root C:\app): 'C:\app\src\lib\a.js' -> 'src/lib/a.js', 'src\lib\a.js' -> 'src/lib/a.js'.
 */
export function normalizeSourcePath(sourcePath, rootDir) {
    if (path.isAbsolute(sourcePath)) {
        return toForwardSlashes(path.relative(rootDir, sourcePath));
    }
    return toForwardSlashes(sourcePath).replace(/^\.\//, '');
}

// --- Parsing ------------------------------------------------------------------

function createRecord(file) {
    return { file, lines: new Map(), branches: [], isPlaceholder: false };
}

/** lcov writes "-" for a branch whose block never ran; that counts as 0 hits. */
function parseHitCount(text) {
    if (text === '-') {
        return 0;
    }
    return Number(text);
}

function applyLine(record, line) {
    if (line.startsWith('DA:')) {
        const [lineNumber, hits] = line.slice(3).split(',');
        const previous = record.lines.get(Number(lineNumber)) ?? 0;
        record.lines.set(Number(lineNumber), previous + Number(hits));
        return;
    }

    if (line.startsWith('BRDA:')) {
        const [lineNumber, block, branch, hits] = line.slice(5).split(',');
        record.branches.push({
            line: Number(lineNumber),
            block: Number(block),
            branch: Number(branch),
            hits: parseHitCount(hits),
        });
        return;
    }

    if (line.startsWith('FN:') && line.endsWith(`,${PLACEHOLDER_FUNCTION}`)) {
        record.isPlaceholder = true;
    }
}

/**
 * Parses lcov text into records. Summary lines (LF, LH, BRF, ...) are ignored because the
 * totals are recomputed from DA and BRDA after merging. Throws when the text lists no files or
 * ends inside a record (a truncated report).
 */
export function parseLcov(text, rootDir) {
    const records = [];
    let current = null;

    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('SF:')) {
            current = createRecord(normalizeSourcePath(line.slice(3).trim(), rootDir));
            records.push(current);
            continue;
        }

        if (line === 'end_of_record') {
            current = null;
            continue;
        }

        if (current) {
            applyLine(current, line);
        }
    }

    if (records.length === 0) {
        throw new Error('the report lists no files (empty lcov)');
    }
    if (current) {
        throw new Error(`the report is truncated: no end_of_record after ${current.file}`);
    }

    return records;
}

// --- Counting -----------------------------------------------------------------

/** Returns { linesFound, linesHit, branchesFound, branchesHit } for a record. */
export function countRecord(record) {
    let linesHit = 0;
    for (const hits of record.lines.values()) {
        if (hits > 0) {
            linesHit += 1;
        }
    }

    let branchesHit = 0;
    for (const branch of record.branches) {
        if (branch.hits > 0) {
            branchesHit += 1;
        }
    }

    return {
        linesFound: record.lines.size,
        linesHit,
        branchesFound: record.branches.length,
        branchesHit,
    };
}

// --- Merging ------------------------------------------------------------------

function hasAnyHitLine(record) {
    return countRecord(record).linesHit > 0;
}

/**
 * Picks which of one file's records take part in the merge.
 *
 * A file no test ran still gets a record from each runner (both use `--all`), but those
 * records list different line sets: c8's placeholder lists every physical line, comments
 * included, while Vitest's lists only code lines. Mixing an unexecuted record into the union
 * would add phantom uncovered lines, so:
 *   - if any record has a hit line, only the records with hits are merged;
 *   - otherwise one record is kept, preferring a real one over a c8 placeholder and then the
 *     one with fewer lines (the source-mapped one).
 */
export function selectRecordsToMerge(records) {
    const executed = records.filter(hasAnyHitLine);
    if (executed.length > 0) {
        return executed;
    }

    const ranked = [...records].sort((first, second) => {
        if (first.isPlaceholder !== second.isPlaceholder) {
            return first.isPlaceholder ? 1 : -1;
        }
        return first.lines.size - second.lines.size;
    });
    return [ranked[0]];
}

/**
 * Chooses the branch list for a merged file.
 *
 * Branches can't be unioned key by key: each runner numbers its blocks independently and
 * Vitest maps branch ranges back through Vite's transform, so `BRDA:68,5,0` in one report
 * and `BRDA:68,5,0` in the other are usually different branches. Instead the record that
 * proves the most branches taken wins; on a tie the one reporting more branches wins, so
 * the result never claims more than one runner actually observed.
 */
function pickBranchRecord(records) {
    let best = records[0];
    for (const record of records.slice(1)) {
        const bestCounts = countRecord(best);
        const counts = countRecord(record);
        const provesMore = counts.branchesHit > bestCounts.branchesHit;
        const sameHitsButMoreBranches = counts.branchesHit === bestCounts.branchesHit
            && counts.branchesFound > bestCounts.branchesFound;
        if (provesMore || sameHitsButMoreBranches) {
            best = record;
        }
    }
    return best;
}

/**
 * Sums hits per line over the lines every record lists. Both runners map to the original
 * source, but each also lists lines the other doesn't (c8 adds 0-hit comment and inner
 * lines), and those extras would count as uncovered even though one runner never considered
 * them code. A line only one runner lists is therefore dropped when several ran.
 */
function unionLines(records) {
    const lines = new Map();
    for (const [lineNumber, hits] of records[0].lines) {
        lines.set(lineNumber, hits);
    }

    for (const record of records.slice(1)) {
        for (const lineNumber of [...lines.keys()]) {
            if (!record.lines.has(lineNumber)) {
                lines.delete(lineNumber);
                continue;
            }
            lines.set(lineNumber, lines.get(lineNumber) + record.lines.get(lineNumber));
        }
    }
    return lines;
}

function mergeFileRecords(file, records) {
    const selected = selectRecordsToMerge(records);
    return {
        file,
        lines: unionLines(selected),
        branches: pickBranchRecord(selected).branches.map((branch) => ({ ...branch })),
        isPlaceholder: selected.every((record) => record.isPlaceholder),
    };
}

/**
 * Merges records from any number of reports into one record per file, dropping files for
 * which `isExcluded(file)` is true. Returns the records sorted by path.
 */
export function mergeRecords(records, isExcluded = () => false) {
    const recordsByFile = new Map();
    for (const record of records) {
        if (isExcluded(record.file)) {
            continue;
        }
        if (!recordsByFile.has(record.file)) {
            recordsByFile.set(record.file, []);
        }
        recordsByFile.get(record.file).push(record);
    }

    const merged = [];
    for (const [file, fileRecords] of recordsByFile) {
        merged.push(mergeFileRecords(file, fileRecords));
    }
    merged.sort((first, second) => first.file.localeCompare(second.file));
    return merged;
}

// --- Writing ------------------------------------------------------------------

function formatRecord(record) {
    const counts = countRecord(record);
    const output = ['TN:', `SF:${record.file}`];

    const lineNumbers = [...record.lines.keys()].sort((first, second) => first - second);
    for (const lineNumber of lineNumbers) {
        output.push(`DA:${lineNumber},${record.lines.get(lineNumber)}`);
    }
    output.push(`LF:${counts.linesFound}`, `LH:${counts.linesHit}`);

    for (const branch of record.branches) {
        output.push(`BRDA:${branch.line},${branch.block},${branch.branch},${branch.hits}`);
    }
    output.push(`BRF:${counts.branchesFound}`, `BRH:${counts.branchesHit}`);

    output.push('end_of_record');
    return output.join('\n');
}

/** Serialises records back to lcov. Function data isn't carried over; no target uses it. */
export function formatLcov(records) {
    return records.map(formatRecord).join('\n') + '\n';
}
