import React, { useEffect, useState } from 'react';
import AboutSection from './AboutSection.jsx';
import { errorMessage } from './errorMessage.js';
import GeminiKeySection from './GeminiKeySection.jsx';
import GeminiModelSection from './GeminiModelSection.jsx';
import ResetDataSection from './ResetDataSection.jsx';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */
/** @typedef {import('../shared/launcherBridge').Settings} Settings */

/**
 * The Gemini key and model the server starts with, Reset data, and About.
 * @param {{ launcher: LauncherBridge, status: import('../shared/launcherBridge').HostingStatus | null }} props
 */
export default function SettingsScreen({ launcher, status }) {
    const [settings, setSettings] = useState(/** @type {Settings | null} */ (null));
    const [loadError, setLoadError] = useState(/** @type {string | null} */ (null));

    useEffect(() => {
        let isCurrent = true;

        launcher.getSettings()
            .then((loaded) => {
                if (isCurrent) {
                    setSettings(loaded);
                }
            })
            .catch((error) => {
                if (isCurrent) {
                    setLoadError(`Couldn't load the settings: ${errorMessage(error)}`);
                }
            });

        return () => {
            isCurrent = false;
        };
    }, [launcher]);

    if (loadError) {
        return <p role="alert" className="launcher-glass p-4 text-sm text-destructive">{loadError}</p>;
    }
    if (!settings) {
        return <p className="text-sm text-indigo-100/70">Loading settings…</p>;
    }

    // The server reads its settings when it starts, so a change made while hosting waits. Until
    // the first snapshot (status null) it isn't known whether anything is running.
    const appliesNextStart = status !== null && status !== 'idle' && status !== 'failed';

    return (
        <div className="flex flex-col gap-3">
            {appliesNextStart && (
                <p className="launcher-hint px-3 py-2.5 text-sm">Changes apply the next time you start hosting.</p>
            )}
            <div className="launcher-glass p-4">
                <GeminiKeySection
                    launcher={launcher}
                    savedKey={settings.geminiApiKey}
                    secretStorage={settings.secretStorage}
                />
            </div>
            <div className="launcher-glass p-4">
                <GeminiModelSection launcher={launcher} savedModel={settings.geminiModel} />
            </div>
            <div className="launcher-glass p-4">
                <ResetDataSection launcher={launcher} status={status} />
            </div>
            <div className="launcher-glass p-4">
                <AboutSection launcher={launcher} />
            </div>
        </div>
    );
}
