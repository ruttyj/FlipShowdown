// Coverage targets per area and the check that
// enforces them. An area passes when its *total* lines and branches meet the target; single
// files below target are listed as warnings so the gaps are visible without failing the run.

import { countRecord } from './lcov.mjs';

// --- Targets ------------------------------------------------------------------

// Paths are relative to the directory the report was written from: the repo root for the
// client, server/ for the server. The first matching area wins, which matters for
// src/pages/gameRoom/use*.js (hooks) versus the rest of src/pages/** (pages).
export const AREA_SETS = {
    client: [
        {
            name: 'src/lib + src/api',
            lines: 98,
            branches: 95,
            matches: (file) => file.startsWith('src/lib/') || file.startsWith('src/api/'),
        },
        {
            // Client and server both run it, and it is measured here, with the tests in tests/.
            name: 'shared',
            lines: 98,
            branches: 95,
            matches: (file) => file.startsWith('shared/'),
        },
        {
            name: 'src/hooks + gameRoom/use*.js',
            lines: 90,
            branches: 85,
            // e.g. src/pages/gameRoom/useGameRoom.js, but not src/pages/gameRoom/JoinScreen.jsx
            matches: (file) => file.startsWith('src/hooks/') || /^src\/pages\/gameRoom\/use[^/]*\.js$/.test(file),
        },
        {
            name: 'src/components/game + src/pages',
            lines: 80,
            branches: 70,
            matches: (file) => file.startsWith('src/components/game/') || file.startsWith('src/pages/'),
        },
        {
            // The Electron launcher's main process. Optional because main.js (the entry point)
            // is excluded and is the only file so far; the area is gated once a module lands.
            name: 'desktop/src/main',
            lines: 98,
            branches: 95,
            optional: true,
            matches: (file) => file.startsWith('desktop/src/main/'),
        },
        {
            // The launcher's React page, measured by Vitest like the app's components.
            name: 'desktop/src/renderer',
            lines: 80,
            branches: 70,
            matches: (file) => file.startsWith('desktop/src/renderer/'),
        },
    ],
    server: [
        {
            name: 'server/src',
            lines: 98,
            branches: 95,
            matches: (file) => file.startsWith('src/'),
        },
    ],
};

// Not ours to test (shadcn copies and generated helpers, the entry point) or not a target
// (src/utils and src/types are leftovers c8 picks up as .ts). Kept in step with the c8
// flags in package.json and the Vitest coverage.exclude list.
const CLIENT_EXCLUSIONS = [
    (file) => file.startsWith('src/components/ui/'),
    (file) => file.startsWith('src/utils/'),
    (file) => file.startsWith('src/types/'),
    (file) => file === 'src/lib/utils.js',
    (file) => file === 'src/hooks/use-mobile.jsx',
    (file) => file === 'src/main.jsx',
    (file) => file === 'desktop/src/renderer/main.jsx',
];

export const EXCLUSIONS = {
    client: CLIENT_EXCLUSIONS,
    server: [],
};

export function isExcludedFrom(areaSetName, file) {
    return EXCLUSIONS[areaSetName].some((isExcluded) => isExcluded(file));
}

// --- Evaluation ---------------------------------------------------------------

/** Percentage with nothing-to-cover counted as fully covered. */
export function percentage(hit, found) {
    if (found === 0) {
        return 100;
    }
    return (100 * hit) / found;
}

function createTotals(area) {
    return { area, fileCount: 0, linesFound: 0, linesHit: 0, branchesFound: 0, branchesHit: 0, filesBelowTarget: [] };
}

function addFileToTotals(totals, record) {
    const counts = countRecord(record);
    totals.fileCount += 1;
    totals.linesFound += counts.linesFound;
    totals.linesHit += counts.linesHit;
    totals.branchesFound += counts.branchesFound;
    totals.branchesHit += counts.branchesHit;

    const linePercent = percentage(counts.linesHit, counts.linesFound);
    const branchPercent = percentage(counts.branchesHit, counts.branchesFound);
    const fileIsBelowTarget = totals.area !== null
        && (linePercent < totals.area.lines || branchPercent < totals.area.branches);
    if (fileIsBelowTarget) {
        totals.filesBelowTarget.push({ file: record.file, linePercent, branchPercent });
    }
}

/** The larger gap between a file and either of its area's targets. */
function shortfall(entry, area) {
    return Math.max(area.lines - entry.linePercent, area.branches - entry.branchPercent);
}

function finishTotals(totals) {
    const linePercent = percentage(totals.linesHit, totals.linesFound);
    const branchPercent = percentage(totals.branchesHit, totals.branchesFound);
    if (totals.area === null) {
        return { ...totals, linePercent, branchPercent, passes: true };
    }

    // An area with no files means the report is empty or truncated, or the area's paths no
    // longer match; counting that as 100% covered would hide it. Optional areas are the
    // exception: they have no measured files yet, so they are skipped until one exists.
    const hasFiles = totals.fileCount > 0;
    if (!hasFiles && totals.area.optional) {
        return { ...totals, linePercent, branchPercent, passes: true };
    }
    const passes = hasFiles && linePercent >= totals.area.lines && branchPercent >= totals.area.branches;
    const filesBelowTarget = [...totals.filesBelowTarget].sort(
        (first, second) => shortfall(second, totals.area) - shortfall(first, totals.area),
    );
    return { ...totals, linePercent, branchPercent, passes, filesBelowTarget };
}

/**
 * Totals the records per area. Returns { areas: [...], other } where each entry has the
 * counts, linePercent, branchPercent, passes and filesBelowTarget; `other` collects files
 * in no area (e.g. src/App.jsx) for information only and always passes.
 */
export function evaluateAreas(records, areas) {
    const totalsByArea = new Map();
    for (const area of areas) {
        totalsByArea.set(area, createTotals(area));
    }
    const other = createTotals(null);

    for (const record of records) {
        const area = areas.find((candidate) => candidate.matches(record.file));
        if (area) {
            addFileToTotals(totalsByArea.get(area), record);
        } else {
            addFileToTotals(other, record);
        }
    }

    const evaluated = [];
    for (const totals of totalsByArea.values()) {
        evaluated.push(finishTotals(totals));
    }
    return { areas: evaluated, other: finishTotals(other) };
}

// --- Summary text -------------------------------------------------------------

function formatPercent(value) {
    return `${value.toFixed(2)}%`;
}

function formatAreaLine(result) {
    const status = result.passes ? 'PASS' : 'FAIL';
    const isSkipped = result.fileCount === 0 && result.area.optional;
    if (isSkipped) {
        return `SKIP  ${result.area.name}: no measured files yet (optional area)`;
    }
    if (result.fileCount === 0) {
        return `${status}  ${result.area.name}: no files in the report (empty or truncated lcov, or the area's paths match nothing)`;
    }
    const lines = `lines ${formatPercent(result.linePercent)} (${result.linesHit}/${result.linesFound}, target ${result.area.lines}%)`;
    const branches = `branches ${formatPercent(result.branchPercent)} (${result.branchesHit}/${result.branchesFound}, target ${result.area.branches}%)`;
    return `${status}  ${result.area.name}: ${lines}, ${branches}`;
}

function formatWarnings(result) {
    const output = [];
    if (result.filesBelowTarget.length === 0) {
        return output;
    }

    output.push(`  warning: ${result.filesBelowTarget.length} file(s) in ${result.area.name} below target:`);
    for (const entry of result.filesBelowTarget) {
        output.push(`    ${entry.file}  lines ${formatPercent(entry.linePercent)}, branches ${formatPercent(entry.branchPercent)}`);
    }
    return output;
}

/** Human-readable report: one line per area, then the files below target. */
export function formatSummary(evaluation) {
    const output = ['Coverage by area'];
    for (const result of evaluation.areas) {
        output.push(formatAreaLine(result));
    }

    const { other } = evaluation;
    if (other.linesFound > 0) {
        output.push(`info  files in no area: lines ${formatPercent(other.linePercent)} (${other.linesHit}/${other.linesFound}), branches ${formatPercent(other.branchPercent)} (${other.branchesHit}/${other.branchesFound})`);
    }

    for (const result of evaluation.areas) {
        output.push(...formatWarnings(result));
    }
    return output.join('\n') + '\n';
}
