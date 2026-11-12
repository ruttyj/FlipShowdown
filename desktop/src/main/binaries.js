// Where the launcher finds the things it runs: the bundled cloudflared binary, the server entry
// and the built client. Every input is injected so the paths can be tested without Electron.
//
// Packaged: electron-builder's extraResources copies them into process.resourcesPath.
// From source: the server and client are staged (copied) under desktop/build, because a utility
// process cannot load the repo's live server/ with an Electron-ABI better-sqlite3, and the
// cloudflared binary is fetched into desktop/resources.
import path from 'node:path';

/**
 * @typedef {object} LayoutInput
 * @property {boolean} isPackaged     app.isPackaged
 * @property {string} resourcesPath   process.resourcesPath (used when packaged)
 * @property {string} desktopRoot     the desktop/ package folder (used from source)
 */

/**
 * Absolute path of the cloudflared binary for this OS and CPU, e.g.
 * `<resources>/cloudflared/win32-x64/cloudflared.exe`.
 * @param {LayoutInput & { platform: string, arch: string }} input
 * @returns {string}
 */
export function resolveCloudflaredPath({ isPackaged, resourcesPath, desktopRoot, platform, arch }) {
    let resourcesRoot = path.join(desktopRoot, 'resources');
    if (isPackaged) {
        resourcesRoot = resourcesPath;
    }

    const fileName = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return path.join(resourcesRoot, 'cloudflared', `${platform}-${arch}`, fileName);
}

/**
 * Where the server to fork lives and which folder it serves the client from.
 * @param {LayoutInput} input
 * @returns {{ serverRoot: string, entryPath: string, staticDir: string }}
 */
export function resolveServerPaths({ isPackaged, resourcesPath, desktopRoot }) {
    let root = path.join(desktopRoot, 'build');
    if (isPackaged) {
        root = resourcesPath;
    }

    const serverRoot = path.join(root, 'server');
    return {
        serverRoot,
        entryPath: path.join(serverRoot, 'src', 'index.js'),
        staticDir: path.join(root, 'dist'),
    };
}

/**
 * The licence files the launcher's About section opens (X68): the app's own LICENSE, the client
 * build's THIRD_PARTY_NOTICES.txt and cloudflared's Apache-2.0 licence.
 * @param {LayoutInput} input
 * @returns {{ app: string, 'third-party': string, cloudflared: string }}
 */
export function resolveLicensePaths({ isPackaged, resourcesPath, desktopRoot }) {
    if (isPackaged) {
        return {
            app: path.join(resourcesPath, 'LICENSE.txt'),
            'third-party': path.join(resourcesPath, 'dist', 'THIRD_PARTY_NOTICES.txt'),
            cloudflared: path.join(resourcesPath, 'cloudflared', 'LICENSE.txt'),
        };
    }
    return {
        app: path.join(desktopRoot, '..', 'LICENSE'),
        'third-party': path.join(desktopRoot, 'build', 'dist', 'THIRD_PARTY_NOTICES.txt'),
        cloudflared: path.join(desktopRoot, 'resources', 'cloudflared', 'LICENSE'),
    };
}
