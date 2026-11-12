import React, { useState } from 'react';
import { useDuplicateTab } from '@/hooks/useDuplicateTab';

// Dismissible banner shown when this room is also open in another tab.
export default function DuplicateTabNotice({ roomId }) {
    const isDuplicate = useDuplicateTab(roomId);
    const [isDismissed, setIsDismissed] = useState(false);

    if (!isDuplicate || isDismissed) {
        return null;
    }

    return (
        <div className="fixed top-2 left-2 right-2 z-[60] flex items-center justify-between gap-3 rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-black shadow-lg">
            <span>This room is open in another tab. Close one to avoid double actions.</span>
            <button onClick={() => setIsDismissed(true)} className="font-bold" aria-label="Dismiss">
                OK
            </button>
        </div>
    );
}
