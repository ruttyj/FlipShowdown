import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * @param {object} props
 * @param {boolean} props.open
 * @param {(open: boolean) => void} props.onOpenChange
 * @param {React.ReactNode} props.title
 * @param {React.ReactNode} props.description
 * @param {string} [props.confirmText]
 * @param {string} [props.cancelText]
 * @param {() => unknown} props.onConfirm  may return a promise; the dialog waits for it
 * @param {() => void} [props.onCancel]
 * @param {'default'|'destructive'} [props.variant]
 */
export default function ConfirmDialog({
    open,
    onOpenChange,
    title,
    description,
    confirmText = "Confirm",
    cancelText = "Cancel",
    onConfirm,
    // Optional: called when the Cancel button is tapped, before the dialog closes. Escape
    // only calls onOpenChange(false), so a caller can tell "Cancel" from a dismissal.
    onCancel,
    variant = "default" // default, destructive
}) {
    const [isPending, setIsPending] = useState(false);
    const [errorMessage, setErrorMessage] = useState(null);

    // onConfirm may be sync or return a promise. The dialog stays open (and shows the
    // error) if it fails, and can't be dismissed or double-submitted while pending.
    const handleConfirm = async (event) => {
        event.preventDefault();
        setIsPending(true);
        setErrorMessage(null);
        try {
            await onConfirm();
            onOpenChange(false);
        } catch (error) {
            setErrorMessage(error?.message || 'Something went wrong. Please try again.');
        } finally {
            setIsPending(false);
        }
    };

    const handleCancel = () => {
        if (onCancel) {
            onCancel();
        }
    };

    const handleOpenChange = (nextOpen) => {
        if (isPending) {
            return;
        }
        setErrorMessage(null);
        onOpenChange(nextOpen);
    };

    return (
        <AlertDialog open={open} onOpenChange={handleOpenChange}>
            <AlertDialogContent className="max-w-sm gap-6">
                <AlertDialogHeader className="gap-3">
                    <AlertDialogTitle className="text-2xl">{title}</AlertDialogTitle>
                    <AlertDialogDescription className="text-base">{description}</AlertDialogDescription>
                    {errorMessage && (
                        <p role="alert" className="text-sm text-red-600">{errorMessage}</p>
                    )}
                </AlertDialogHeader>
                <AlertDialogFooter className="flex-col-reverse sm:flex-row gap-3 sm:gap-4">
                    <AlertDialogCancel
                        disabled={isPending}
                        onClick={handleCancel}
                        className="h-12 sm:h-auto text-base sm:text-sm"
                    >
                        {cancelText}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={handleConfirm}
                        disabled={isPending}
                        autoFocus
                        className={`h-12 sm:h-auto text-base sm:text-sm font-semibold ${
                            variant === "destructive"
                                ? "bg-red-600 hover:bg-red-700"
                                : "bg-ui-accent hover:bg-ui-accent-strong"
                        }`}
                    >
                        {isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {confirmText}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}
