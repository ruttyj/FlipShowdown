// Notify-only update check (decision 16): compares the latest GitHub Release tag with the app
// version and hands back the release page for a download link. It never downloads or installs
// anything, and any failure simply means "no update".

/** Used when package.json has no GitHub `repository`. */
export const DEFAULT_REPO = 'ruttyj/FlipShowdown';

const REQUEST_TIMEOUT_MS = 10_000;
const RELEASE_PAGE_PREFIX = 'https://github.com/';

// "owner/repo", "github:owner/repo", or a github.com https/ssh URL, optionally ending in ".git".
const REPO_SLUG_PATTERN = /^(?:github:|(?:git\+)?https:\/\/github\.com\/|git@github\.com:)?([\w.-]+\/[\w.-]+?)(?:\.git)?$/;
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)$/;

/**
 * @typedef {object} UpdateResult
 * @property {boolean} updateAvailable
 * @property {string | null} latestVersion  Without the "v", e.g. "1.2.0".
 * @property {string | null} url            The release page on github.com.
 */

/** @type {Readonly<UpdateResult>} */
const NO_UPDATE = Object.freeze({ updateAvailable: false, latestVersion: null, url: null });

// --- Repo and versions -------------------------------------------------------

/**
 * The "owner/repo" from a package.json `repository` field, or DEFAULT_REPO.
 * @param {{ repository?: unknown } | undefined} packageJson
 */
export function repoSlugFromPackage(packageJson) {
    let repository = packageJson?.repository;
    if (typeof repository === 'object' && repository !== null && 'url' in repository) {
        repository = repository.url;
    }
    if (typeof repository !== 'string') {
        return DEFAULT_REPO;
    }

    const match = repository.trim().match(REPO_SLUG_PATTERN);
    if (!match) {
        return DEFAULT_REPO;
    }
    return match[1];
}

/**
 * [major, minor, patch] for "1.2.3" or "v1.2.3"; null for anything else, pre-releases included.
 * @param {unknown} text
 * @returns {[number, number, number] | null}
 */
export function parseVersion(text) {
    if (typeof text !== 'string') {
        return null;
    }

    const match = text.match(VERSION_PATTERN);
    if (!match) {
        return null;
    }
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Negative when `a` is older than `b`, positive when newer, 0 when equal.
 * @param {number[]} a
 * @param {number[]} b
 */
export function compareVersions(a, b) {
    for (let index = 0; index < 3; index++) {
        if (a[index] !== b[index]) {
            return a[index] - b[index];
        }
    }
    return 0;
}

// --- Checking ------------------------------------------------------------------

/**
 * @param {string} repo
 * @param {typeof globalThis.fetch} fetch
 * @returns {Promise<unknown>} The parsed release, or null when the request failed.
 */
async function fetchLatestRelease(repo, fetch) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
        return null;
    }
    return response.json();
}

/**
 * Turns a GitHub release into an UpdateResult, or NO_UPDATE when its tag isn't a "v1.2.3"
 * release or its page isn't on github.com (the page is shown as a link, so it must be safe).
 * @param {unknown} release
 * @param {[number, number, number]} current
 * @returns {UpdateResult}
 */
function resultFromRelease(release, current) {
    if (typeof release !== 'object' || release === null) {
        return NO_UPDATE;
    }

    const tag = 'tag_name' in release ? release.tag_name : undefined;
    const url = 'html_url' in release ? release.html_url : undefined;
    const isReleaseTag = typeof tag === 'string' && tag.startsWith('v');
    const latest = isReleaseTag ? parseVersion(tag) : null;
    const isGitHubPage = typeof url === 'string' && url.startsWith(RELEASE_PAGE_PREFIX);
    if (!latest || !isGitHubPage) {
        return NO_UPDATE;
    }

    return {
        updateAvailable: compareVersions(latest, current) > 0,
        latestVersion: latest.join('.'),
        url,
    };
}

/**
 * Asks GitHub for the latest release of `repo` and compares it with `currentVersion`.
 * Never throws: any failure resolves to "no update".
 * @param {object} options
 * @param {string} options.currentVersion  The app version, e.g. app.getVersion().
 * @param {string} [options.repo]
 * @param {typeof globalThis.fetch} [options.fetch]  Injected in tests.
 * @returns {Promise<UpdateResult>}
 */
export async function checkForUpdate({ currentVersion, repo = DEFAULT_REPO, fetch = globalThis.fetch }) {
    const current = parseVersion(currentVersion);
    if (!current) {
        return NO_UPDATE;
    }

    try {
        const release = await fetchLatestRelease(repo, fetch);
        return resultFromRelease(release, current);
    } catch {
        return NO_UPDATE;
    }
}
