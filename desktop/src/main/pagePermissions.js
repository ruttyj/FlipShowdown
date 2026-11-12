// Which web permissions the launcher page gets. Everything is denied except writing to the
// clipboard, which the Copy buttons need: Electron checks clipboard-sanitized-write on every
// navigator.clipboard.writeText (X74). Reading the clipboard stays denied.
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/**
 * @param {string} permission an Electron permission name
 * @returns {boolean}
 */
export function isPermissionAllowed(permission) {
    return ALLOWED_PERMISSIONS.has(permission);
}
