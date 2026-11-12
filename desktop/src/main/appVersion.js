// The version the launcher shows and compares against GitHub releases. The root package.json is
// the single source: packaged builds get it from electron-builder (extraMetadata.version), so
// app.getVersion() is right there. From source, Electron reads desktop/package.json, whose
// version is only a placeholder, so the root package.json is used instead.

/**
 * @param {object} options
 * @param {boolean} options.isPackaged          app.isPackaged
 * @param {string} options.appVersion           app.getVersion()
 * @param {{ version?: unknown } | null} options.rootPackageJson  the parsed root package.json,
 *   or null when it can't be read
 * @returns {string}
 */
export function resolveAppVersion({ isPackaged, appVersion, rootPackageJson }) {
    if (isPackaged) {
        return appVersion;
    }

    const rootVersion = rootPackageJson?.version;
    if (typeof rootVersion !== 'string' || rootVersion === '') {
        return appVersion;
    }
    return rootVersion;
}
