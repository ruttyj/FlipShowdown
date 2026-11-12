import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { errorMessage } from './errorMessage.js';

/** @typedef {import('../shared/launcherBridge').LauncherBridge} LauncherBridge */

// The same rule the bridge enforces (src/main/ipc.js), e.g. "gemini-3.5-flash-lite".
const MODEL_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_MODEL_LENGTH = 100;
const MODEL_INPUT_ID = 'gemini-model';
const MODEL_HELP_ID = 'gemini-model-help';

/**
 * The check the bridge would make, with a message the user can act on; null when it's fine.
 * @param {string} model
 */
function modelProblem(model) {
    if (model === '') {
        return 'Enter a model name.';
    }
    if (!MODEL_PATTERN.test(model)) {
        return 'Use only letters, digits, dots, dashes and underscores.';
    }
    return null;
}

/**
 * Which Gemini model reads the card photos.
 * @param {{ launcher: LauncherBridge, savedModel: string }} props
 */
export default function GeminiModelSection({ launcher, savedModel }) {
    const [model, setModel] = useState(savedModel);
    const [message, setMessage] = useState(/** @type {{ text: string, isError: boolean } | null} */ (null));

    async function save() {
        const trimmedModel = model.trim();
        const problem = modelProblem(trimmedModel);
        if (problem) {
            setMessage({ text: problem, isError: true });
            return;
        }

        try {
            await launcher.saveSettings({ geminiModel: trimmedModel });
            setMessage({ text: 'Model saved.', isError: false });
        } catch (error) {
            setMessage({ text: `Couldn't save the model: ${errorMessage(error)}`, isError: true });
        }
    }

    return (
        <section aria-labelledby="gemini-model-heading" className="flex flex-col gap-3">
            <h2 id="gemini-model-heading" className="launcher-eyebrow">Scanning model</h2>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={MODEL_INPUT_ID} className="text-sm font-medium">Gemini model</label>
                <div className="flex gap-2">
                    <Input
                        id={MODEL_INPUT_ID}
                        spellCheck={false}
                        maxLength={MAX_MODEL_LENGTH}
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        aria-describedby={MODEL_HELP_ID}
                        aria-invalid={message?.isError ? true : undefined}
                        className="launcher-well"
                    />
                    <Button variant="outline" onClick={save}>Save model</Button>
                </div>
                <p id={MODEL_HELP_ID} className="text-sm text-muted-foreground">
                    Leave this as it is unless you know you need another model.
                </p>
            </div>
            <p aria-live="polite" className={`min-h-5 text-sm ${message?.isError ? 'text-destructive' : 'text-muted-foreground'}`}>
                {message?.text}
            </p>
        </section>
    );
}
