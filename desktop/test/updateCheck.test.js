import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkForUpdate, compareVersions, DEFAULT_REPO, parseVersion, repoSlugFromPackage } from '../src/main/updateCheck.js';

const NO_UPDATE = { updateAvailable: false, latestVersion: null, url: null };
const RELEASE_URL = 'https://github.com/ruttyj/FlipShowdown/releases/tag/v1.2.0';

/** A fetch stand-in that records its calls and answers with `body` as JSON. */
function fakeFetch(body, status = 200) {
    const calls = [];
    const fetch = async (url, options) => {
        calls.push({ url, options });
        return new Response(JSON.stringify(body), { status });
    };
    return { fetch, calls };
}

function release(tagName, htmlUrl = RELEASE_URL) {
    return { tag_name: tagName, html_url: htmlUrl };
}

// --- Repo slug ---

test('repoSlugFromPackage falls back to the default repo', () => {
    assert.equal(DEFAULT_REPO, 'ruttyj/FlipShowdown');
    assert.equal(repoSlugFromPackage({}), DEFAULT_REPO);
    assert.equal(repoSlugFromPackage(undefined), DEFAULT_REPO);
    assert.equal(repoSlugFromPackage({ repository: 'https://gitlab.com/a/b' }), DEFAULT_REPO);
    assert.equal(repoSlugFromPackage({ repository: 42 }), DEFAULT_REPO);
});

test('repoSlugFromPackage reads the common package.json repository forms', () => {
    const cases = [
        ['owner/repo', 'owner/repo'],
        ['github:owner/repo', 'owner/repo'],
        ['https://github.com/owner/repo', 'owner/repo'],
        ['https://github.com/owner/repo.git', 'owner/repo'],
        ['git+https://github.com/owner/repo.git', 'owner/repo'],
        ['git@github.com:owner/repo.git', 'owner/repo'],
    ];
    for (const [repository, expected] of cases) {
        assert.equal(repoSlugFromPackage({ repository }), expected, repository);
    }
    assert.equal(repoSlugFromPackage({ repository: { type: 'git', url: 'https://github.com/o/r.git' } }), 'o/r');
});

// --- Versions ---

test('parseVersion reads plain and v-prefixed versions', () => {
    assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
    assert.deepEqual(parseVersion('v10.0.7'), [10, 0, 7]);
});

test('parseVersion rejects anything that is not a plain release version', () => {
    for (const text of ['', '1.2', 'v1.2.3-beta.1', 'latest', '1.2.3.4', undefined]) {
        assert.equal(parseVersion(text), null, String(text));
    }
});

test('compareVersions orders by major, then minor, then patch', () => {
    assert.ok(compareVersions([1, 0, 0], [0, 9, 9]) > 0);
    assert.ok(compareVersions([1, 2, 0], [1, 10, 0]) < 0);
    assert.ok(compareVersions([1, 2, 4], [1, 2, 3]) > 0);
    assert.equal(compareVersions([1, 2, 3], [1, 2, 3]), 0);
});

// --- Checking ---

test('checkForUpdate asks the GitHub API for the latest release of the repo', async () => {
    const { fetch, calls } = fakeFetch(release('v1.0.0'));

    await checkForUpdate({ currentVersion: '1.0.0', repo: 'o/r', fetch });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.github.com/repos/o/r/releases/latest');
    assert.equal(calls[0].options.headers.Accept, 'application/vnd.github+json');
});

test('checkForUpdate uses the default repo when none is given', async () => {
    const { fetch, calls } = fakeFetch(release('v1.0.0'));

    await checkForUpdate({ currentVersion: '1.0.0', fetch });

    assert.equal(calls[0].url, `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`);
});

test('checkForUpdate reports a newer release with its page', async () => {
    const { fetch } = fakeFetch(release('v1.2.0'));

    const result = await checkForUpdate({ currentVersion: '1.1.9', fetch });

    assert.deepEqual(result, { updateAvailable: true, latestVersion: '1.2.0', url: RELEASE_URL });
});

test('checkForUpdate reports no update when the release is the same or older', async () => {
    for (const tag of ['v1.1.0', 'v1.0.5']) {
        const { fetch } = fakeFetch(release(tag));

        const result = await checkForUpdate({ currentVersion: '1.1.0', fetch });

        assert.equal(result.updateAvailable, false, tag);
        assert.equal(result.latestVersion, tag.slice(1), tag);
        assert.equal(result.url, RELEASE_URL, tag);
    }
});

test('checkForUpdate ignores tags that are not v-prefixed release versions', async () => {
    for (const tag of ['1.2.0', 'v2.0.0-rc.1', 'nightly', undefined]) {
        const { fetch } = fakeFetch(release(tag));

        assert.deepEqual(await checkForUpdate({ currentVersion: '1.0.0', fetch }), NO_UPDATE, String(tag));
    }
});

test('checkForUpdate reports no update when the app version cannot be read', async () => {
    const { fetch } = fakeFetch(release('v9.0.0'));

    assert.deepEqual(await checkForUpdate({ currentVersion: 'dev', fetch }), NO_UPDATE);
});

test('checkForUpdate reports no update when the release page is not a GitHub https link', async () => {
    for (const htmlUrl of ['javascript:alert(1)', 'http://github.com/x', 'https://evil.example/x', null]) {
        const { fetch } = fakeFetch(release('v9.0.0', htmlUrl));

        assert.deepEqual(await checkForUpdate({ currentVersion: '1.0.0', fetch }), NO_UPDATE, String(htmlUrl));
    }
});

test('checkForUpdate never throws', async () => {
    const failures = [
        fakeFetch({ message: 'Not Found' }, 404).fetch,
        fakeFetch(null).fetch,
        async () => new Response('not json', { status: 200 }),
        async () => {
            throw new TypeError('fetch failed');
        },
    ];
    for (const fetch of failures) {
        assert.deepEqual(await checkForUpdate({ currentVersion: '1.0.0', fetch }), NO_UPDATE);
    }
});
