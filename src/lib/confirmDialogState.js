// The shared confirm dialog's state, kept free of React so it can be tested.
//
// Every dialog gets an id. The screens close a dialog by passing back the dialog they were
// rendered with, so a close that arrives late (ConfirmDialog calls onOpenChange(false) after
// onConfirm, by which time the caller may already have opened the next dialog) carries the
// old id and is ignored instead of dismissing the new dialog.

export const CLOSED_DIALOG = {
    id: 0,
    open: false,
    title: '',
    description: '',
    confirmText: undefined,
    cancelText: undefined,
    onConfirm: null,
    onCancel: null,
    variant: 'default',
};

/**
 * @param {(dialog: object) => void} publish  called with the dialog to render
 * @returns {{ ask: (options: object) => Promise<'confirm'|'cancel'|'dismiss'>, change: (dialog: object) => void }}
 *   `ask` opens a dialog and resolves with how it ended: 'confirm', 'cancel' (the Cancel
 *   button) or 'dismiss' (Escape, or replaced by another dialog). `change` is how a rendered
 *   dialog closes itself.
 */
export function createConfirmDialogController(publish) {
    let lastId = 0;
    let shownId = 0;
    // { id, resolve } of the dialog still waiting for an answer, or null.
    let waiting = null;

    function settle(id, answer) {
        if (!waiting || waiting.id !== id) {
            return;
        }
        const { resolve } = waiting;
        waiting = null;
        resolve(answer);
    }

    function ask(options) {
        if (waiting) {
            settle(waiting.id, 'dismiss');
        }

        lastId += 1;
        const id = lastId;
        shownId = id;
        return new Promise((resolve) => {
            waiting = { id, resolve };
            publish({
                ...CLOSED_DIALOG,
                ...options,
                id,
                open: true,
                onConfirm: () => settle(id, 'confirm'),
                onCancel: () => settle(id, 'cancel'),
            });
        });
    }

    function change(dialog) {
        const isCurrentDialog = dialog.id === shownId;
        if (!isCurrentDialog) {
            return;
        }

        if (!dialog.open) {
            settle(dialog.id, 'dismiss');
        }
        publish(dialog);
    }

    return { ask, change };
}
