import React from 'react';
import { MAX_CARDS_PER_ROUND } from '@/lib/scoreEntryCards';

/** Says why Confirm or Save is disabled on a hand the server wouldn't accept. */
export default function TooManyCardsAlert() {
    return (
        <p role="alert" className="text-sm text-red-600">
            A round can have at most {MAX_CARDS_PER_ROUND} cards. Remove some to continue.
        </p>
    );
}
