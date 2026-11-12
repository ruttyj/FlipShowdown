import React from 'react';

/**
 * A polite live region for screen readers, kept on the page whether or not it has anything to
 * say. NVDA and JAWS in Chromium often skip a live region that is inserted already holding its
 * text, so callers keep this mounted and change `text` ('' says nothing). The visible banner it
 * describes is rendered separately, with its copy of the text aria-hidden so it isn't read twice.
 * @param {{ text: string, testId: string }} props
 */
export default function LiveAnnouncement({ text, testId }) {
    return <p role="status" data-testid={testId} className="sr-only">{text}</p>;
}
