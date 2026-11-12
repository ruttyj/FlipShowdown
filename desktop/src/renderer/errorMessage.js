/**
 * The text to show for a rejected bridge call. IPC rejections arrive as Error objects whose
 * message Electron prefixes with "Error invoking remote method '<channel>': ", which means
 * nothing to the user, so that part is dropped.
 * @param {unknown} error
 * @returns {string}
 */
export function errorMessage(error) {
    let message = String(error);
    if (error instanceof Error) {
        message = error.message;
    }
    return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, '');
}
