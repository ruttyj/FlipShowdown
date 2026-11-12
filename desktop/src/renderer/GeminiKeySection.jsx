import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from './errorMessage.js';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */

export const API_KEY_PAGE = 'https://aistudio.google.com/apikey';
// The terms the host accepts by using their own key (X69), shown where they decide whether to.
const GEMINI_TERMS_TEXT = "You use your own Google key under Google's Gemini API terms, including their age and region rules. "
    + 'On the free tier, Google may use the photos to improve its products.';
// The bridge refuses longer keys (src/main/ipc.js).
const MAX_KEY_LENGTH = 200;
const KEY_INPUT_ID = 'gemini-api-key';
const KEY_HELP_ID = 'gemini-api-key-help';

/**
 * What the status line says; `isError` marks the key field invalid.
 * @typedef {{ text: string, isError: boolean }} KeyStatus
 */

/** @type {Record<'checking' | 'valid' | 'invalid' | 'unknown' | 'skipped', KeyStatus>} */
const STATUSES = {
    checking: { text: 'Checking the key with Google…', isError: false },
    valid: { text: 'The key works and is saved. Card scanning is on.', isError: false },
    invalid: { text: 'Google rejected this key. Check that you copied all of it.', isError: true },
    unknown: { text: "Couldn't reach Google to check the key. It's saved and will be tried when you host.", isError: false },
    skipped: { text: 'Skipped. Card scanning stays off; you can add a key here any time.', isError: false },
};

/** @type {Record<import('../shared/launcherBridge').SecretStorage, string>} */
const STORAGE_NOTES = {
    encrypted: 'Stored encrypted by your operating system.',
    'plain-text': 'Your system has no keyring, so the key is stored unencrypted.',
};
const KEY_STORAGE_ID = 'gemini-api-key-storage';

/**
 * The optional Gemini key for card scanning: how to get one, Validate and save, or Skip
 * (decision 7). A key Google rejects is not saved; one that couldn't be checked (offline) is.
 * `secretStorage` says whether the saved key is encrypted on disk.
 * @param {{ launcher: LauncherBridge, savedKey: string,
 *   secretStorage: import('../shared/launcherBridge').SecretStorage }} props
 */
export default function GeminiKeySection({ launcher, savedKey, secretStorage }) {
    const [key, setKey] = useState(savedKey);
    const [status, setStatus] = useState(/** @type {KeyStatus | null} */ (null));
    const [linkError, setLinkError] = useState('');
    const isChecking = status === STATUSES.checking;
    const trimmedKey = key.trim();

    async function validateAndSave() {
        setStatus(STATUSES.checking);
        try {
            const result = await launcher.validateGeminiKey(trimmedKey);
            if (result !== 'invalid') {
                await launcher.saveSettings({ geminiApiKey: trimmedKey });
            }
            setStatus(STATUSES[result]);
        } catch (error) {
            setStatus({ text: `Couldn't save the key: ${errorMessage(error)}`, isError: true });
        }
    }

    // The field empties only once the save succeeds, so a failed save leaves it showing the key
    // that is still saved.
    async function skip() {
        try {
            await launcher.saveSettings({ geminiApiKey: '' });
            setKey('');
            setStatus(STATUSES.skipped);
        } catch (error) {
            setStatus({ text: `Couldn't save the key: ${errorMessage(error)}`, isError: true });
        }
    }

    // The status describes the key it was given, so it no longer applies once the field changes.
    function editKey(/** @type {string} */ nextKey) {
        setKey(nextKey);
        setStatus(null);
    }

    async function openKeyPage() {
        setLinkError('');
        try {
            await launcher.openExternal(API_KEY_PAGE);
        } catch (error) {
            setLinkError(`Couldn't open Google AI Studio: ${errorMessage(error)}`);
        }
    }

    return (
        <section aria-labelledby="gemini-key-heading" className="flex flex-col gap-3">
            <h2 id="gemini-key-heading" className="launcher-eyebrow">Card scanning (optional)</h2>
            <p id={KEY_HELP_ID} className="text-sm text-muted-foreground">
                Players can photograph their cards to score a hand. That needs a free Gemini API key from Google.
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
                <li>
                    Open{' '}
                    <Button variant="link" className="h-auto p-0" onClick={openKeyPage}>
                        Google AI Studio
                    </Button>
                    {' '}and sign in with a Google account.
                </li>
                <li>Choose Create API key and copy the key.</li>
                <li>Paste it below and choose Validate and save.</li>
            </ol>
            <p className="text-xs text-muted-foreground">{GEMINI_TERMS_TEXT}</p>
            {linkError && <p role="alert" className="text-sm text-destructive">{linkError}</p>}

            <div className="flex flex-col gap-1.5">
                <label htmlFor={KEY_INPUT_ID} className="text-sm font-medium">Gemini API key</label>
                <Input
                    id={KEY_INPUT_ID}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_KEY_LENGTH}
                    value={key}
                    onChange={(event) => editKey(event.target.value)}
                    aria-describedby={`${KEY_HELP_ID} ${KEY_STORAGE_ID}`}
                    aria-invalid={status?.isError ? true : undefined}
                    className="launcher-well"
                />
                <p id={KEY_STORAGE_ID} className="text-xs text-muted-foreground">{STORAGE_NOTES[secretStorage]}</p>
            </div>
            <div className="flex gap-2">
                <Button className="launcher-action" onClick={validateAndSave} disabled={trimmedKey === '' || isChecking}>
                    Validate and save
                </Button>
                <Button variant="outline" onClick={skip} disabled={isChecking}>Skip</Button>
            </div>
            <p
                data-testid="gemini-key-status"
                aria-live="polite"
                className={`min-h-5 text-sm ${status?.isError ? 'text-destructive' : 'text-muted-foreground'}`}
            >
                {status?.text}
            </p>
        </section>
    );
}
