import React, { useState } from 'react';
import { UNOFFICIAL_DISCLAIMER } from '@/lib/disclaimer';
import { errorMessage } from './errorMessage.js';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../shared/launcherBridge').LicenseName} LicenseName */

/** @type {{ name: LicenseName, label: string }[]} */
const LICENSE_LINKS = [
    { name: 'app', label: 'Licence (MIT)' },
    { name: 'third-party', label: 'Third-party notices' },
    { name: 'cloudflared', label: 'cloudflared licence (Apache-2.0)' },
];

/**
 * The "unofficial" disclaimer (X67) and the licence files the installer ships (X68).
 * @param {{ launcher: LauncherBridge }} props
 */
export default function AboutSection({ launcher }) {
    const [error, setError] = useState(/** @type {string | null} */ (null));

    async function openLicense(/** @type {LicenseName} */ name) {
        setError(null);
        try {
            const result = await launcher.openLicense(name);
            if (result.ok === false) {
                setError(result.error);
            }
        } catch (caught) {
            setError(`Couldn't open the file: ${errorMessage(caught)}`);
        }
    }

    return (
        <section aria-labelledby="about-heading" className="flex flex-col gap-3">
            <h2 id="about-heading" className="launcher-eyebrow">About</h2>
            <p className="text-sm text-muted-foreground">{UNOFFICIAL_DISCLAIMER}</p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {LICENSE_LINKS.map((link) => (
                    <li key={link.name}>
                        <button
                            type="button"
                            onClick={() => openLicense(link.name)}
                            className="font-semibold underline underline-offset-2"
                        >
                            {link.label}
                        </button>
                    </li>
                ))}
            </ul>
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </section>
    );
}
