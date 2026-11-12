import { useCallback, useState } from 'react';
import { CLOSED_DIALOG, createConfirmDialogController } from '@/lib/confirmDialogState';

/**
 * State for the screens' shared ConfirmDialog, plus:
 * - `confirm(options)`: opens it and resolves true when confirmed, false otherwise.
 * - `ask(options)`: the same, resolving 'confirm', 'cancel' or 'dismiss', for prompts where
 *   tapping Cancel means something different from closing the dialog.
 *
 * `confirmDialog.onOpenChange` closes the dialog it came with. Each dialog has an id (see
 * src/lib/confirmDialogState.js), so a late close for a dialog that has already been answered
 * can't dismiss the next one.
 */
export function useConfirmDialog() {
    const [confirmDialog, setDialog] = useState(CLOSED_DIALOG);
    const [controller] = useState(() => createConfirmDialogController(setDialog));

    const confirm = useCallback(async (options) => {
        const answer = await controller.ask(options);
        return answer === 'confirm';
    }, [controller]);

    const onOpenChange = (open) => {
        controller.change({ ...confirmDialog, open });
    };

    return { confirmDialog: { ...confirmDialog, onOpenChange }, confirm, ask: controller.ask };
}
