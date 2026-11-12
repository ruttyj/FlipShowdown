import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, test } from 'vitest';
import LauncherApp from '../../src/renderer/LauncherApp.jsx';
import { UNOFFICIAL_DISCLAIMER } from '@/lib/disclaimer';
import { createFakeLauncher, TUNNEL_URL } from './fakeLauncher.jsx';

const API_KEY_PAGE = 'https://aistudio.google.com/apikey';

/** Renders the launcher, opens the Settings tab and waits for the saved settings. */
async function openSettings(options) {
    const fake = createFakeLauncher(options);
    const user = userEvent.setup();
    render(<LauncherApp launcher={fake.launcher} />);
    await user.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Gemini API key');
    return { fake, user };
}

function keyStatus() {
    return screen.getByTestId('gemini-key-status');
}

// --- Gemini key ----------------------------------------------------------------------------

describe('the Gemini key', () => {
    test('shows the saved key, masked', async () => {
        await openSettings({ settings: { geminiApiKey: 'AIza-saved' } });

        const input = screen.getByLabelText('Gemini API key');
        expect(input).toHaveValue('AIza-saved');
        expect(input).toHaveAttribute('type', 'password');
    });

    test('says the key is stored encrypted when the system has a keyring', async () => {
        await openSettings({ settings: { secretStorage: 'encrypted' } });

        expect(screen.getByText('Stored encrypted by your operating system.')).toBeInTheDocument();
    });

    test('says the key is stored unencrypted when the system has no keyring', async () => {
        await openSettings({ settings: { secretStorage: 'plain-text' } });

        expect(screen.getByText('Your system has no keyring, so the key is stored unencrypted.')).toBeInTheDocument();
        expect(screen.queryByText('Stored encrypted by your operating system.')).not.toBeInTheDocument();
    });

    test('the instructions link to the API key page through the bridge', async () => {
        const { fake, user } = await openSettings();

        await user.click(screen.getByRole('button', { name: 'Google AI Studio' }));

        expect(fake.launcher.openExternal).toHaveBeenCalledWith(API_KEY_PAGE);
    });

    test('an API key page that fails to open says so', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.openExternal.mockRejectedValue(new Error('No browser is set up'));

        await user.click(screen.getByRole('button', { name: 'Google AI Studio' }));

        expect(await screen.findByText("Couldn't open Google AI Studio: No browser is set up")).toBeInTheDocument();
    });

    test('editing the key clears the status about the previous one', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.validateGeminiKey.mockResolvedValue('invalid');
        const input = screen.getByLabelText('Gemini API key');
        await user.type(input, 'nonsense');
        await user.click(screen.getByRole('button', { name: 'Validate and save' }));
        await screen.findByText('Google rejected this key. Check that you copied all of it.');

        await user.type(input, 'x');

        expect(keyStatus()).toBeEmptyDOMElement();
        expect(input).not.toHaveAttribute('aria-invalid');
    });

    test('a Skip whose save fails keeps the key in the field', async () => {
        const { fake, user } = await openSettings({ settings: { geminiApiKey: 'AIza-saved' } });
        fake.launcher.saveSettings.mockRejectedValue(new Error('disk full'));

        await user.click(screen.getByRole('button', { name: 'Skip' }));

        expect(await screen.findByText("Couldn't save the key: disk full")).toBeInTheDocument();
        expect(screen.getByLabelText('Gemini API key')).toHaveValue('AIza-saved');
    });

    test('a valid key is saved and confirmed', async () => {
        const { fake, user } = await openSettings();

        await user.type(screen.getByLabelText('Gemini API key'), '  AIza-good  ');
        await user.click(screen.getByRole('button', { name: 'Validate and save' }));

        expect(fake.launcher.validateGeminiKey).toHaveBeenCalledWith('AIza-good');
        expect(fake.launcher.saveSettings).toHaveBeenCalledWith({ geminiApiKey: 'AIza-good' });
        expect(await screen.findByText('The key works and is saved. Card scanning is on.')).toBeInTheDocument();
        expect(keyStatus()).toHaveAttribute('aria-live', 'polite');
    });

    test('a rejected key is not saved', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.validateGeminiKey.mockResolvedValue('invalid');

        await user.type(screen.getByLabelText('Gemini API key'), 'nonsense');
        await user.click(screen.getByRole('button', { name: 'Validate and save' }));

        expect(await screen.findByText('Google rejected this key. Check that you copied all of it.')).toBeInTheDocument();
        expect(fake.launcher.saveSettings).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Gemini API key')).toHaveAttribute('aria-invalid', 'true');
    });

    test("a key that couldn't be checked is saved anyway", async () => {
        const { fake, user } = await openSettings();
        fake.launcher.validateGeminiKey.mockResolvedValue('unknown');

        await user.type(screen.getByLabelText('Gemini API key'), 'AIza-offline');
        await user.click(screen.getByRole('button', { name: 'Validate and save' }));

        expect(await screen.findByText("Couldn't reach Google to check the key. It's saved and will be tried when you host.")).toBeInTheDocument();
        expect(fake.launcher.saveSettings).toHaveBeenCalledWith({ geminiApiKey: 'AIza-offline' });
    });

    test('shows progress while checking', async () => {
        const { fake, user } = await openSettings();
        let finishCheck;
        fake.launcher.validateGeminiKey.mockImplementation(() => new Promise((resolve) => {
            finishCheck = resolve;
        }));

        await user.type(screen.getByLabelText('Gemini API key'), 'AIza-slow');
        await user.click(screen.getByRole('button', { name: 'Validate and save' }));

        expect(keyStatus()).toHaveTextContent('Checking the key with Google…');
        expect(screen.getByRole('button', { name: 'Validate and save' })).toBeDisabled();
        finishCheck('valid');
        expect(await screen.findByText('The key works and is saved. Card scanning is on.')).toBeInTheDocument();
    });

    test('Validate is disabled until a key is typed', async () => {
        await openSettings();

        expect(screen.getByRole('button', { name: 'Validate and save' })).toBeDisabled();
    });

    test('Skip clears the key and turns scanning off', async () => {
        const { fake, user } = await openSettings({ settings: { geminiApiKey: 'AIza-saved' } });

        await user.click(screen.getByRole('button', { name: 'Skip' }));

        expect(fake.launcher.saveSettings).toHaveBeenCalledWith({ geminiApiKey: '' });
        expect(screen.getByLabelText('Gemini API key')).toHaveValue('');
        expect(await screen.findByText('Skipped. Card scanning stays off; you can add a key here any time.')).toBeInTheDocument();
    });

    test('a save that fails shows the reason', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.saveSettings.mockRejectedValue(new Error('disk full'));

        await user.type(screen.getByLabelText('Gemini API key'), 'AIza-good');
        await user.click(screen.getByRole('button', { name: 'Validate and save' }));

        expect(await screen.findByText("Couldn't save the key: disk full")).toBeInTheDocument();
    });
});

// --- Model ---------------------------------------------------------------------------------

describe('the Gemini model', () => {
    test('shows the saved model and saves a new one', async () => {
        const { fake, user } = await openSettings();
        const input = screen.getByLabelText('Gemini model');
        expect(input).toHaveValue('gemini-3.5-flash-lite');

        await user.clear(input);
        await user.type(input, 'gemini-3.8-flash');
        await user.click(screen.getByRole('button', { name: 'Save model' }));

        expect(fake.launcher.saveSettings).toHaveBeenCalledWith({ geminiModel: 'gemini-3.8-flash' });
        expect(await screen.findByText('Model saved.')).toBeInTheDocument();
    });

    test('rejects a model name with other characters, without saving', async () => {
        const { fake, user } = await openSettings();
        const input = screen.getByLabelText('Gemini model');

        await user.clear(input);
        await user.type(input, 'gemini 3/flash');
        await user.click(screen.getByRole('button', { name: 'Save model' }));

        expect(screen.getByText('Use only letters, digits, dots, dashes and underscores.')).toBeInTheDocument();
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(fake.launcher.saveSettings).not.toHaveBeenCalled();
    });

    test('an empty model name is not saved', async () => {
        const { fake, user } = await openSettings();

        await user.clear(screen.getByLabelText('Gemini model'));
        await user.click(screen.getByRole('button', { name: 'Save model' }));

        expect(screen.getByText('Enter a model name.')).toBeInTheDocument();
        expect(fake.launcher.saveSettings).not.toHaveBeenCalled();
    });

    test('a model save that fails shows the reason', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.saveSettings.mockRejectedValue(new Error('disk full'));

        await user.click(screen.getByRole('button', { name: 'Save model' }));

        expect(await screen.findByText("Couldn't save the model: disk full")).toBeInTheDocument();
    });
});

// --- Reset data ----------------------------------------------------------------------------

describe('Reset data', () => {
    test('asks first, then deletes the data', async () => {
        const { fake, user } = await openSettings();

        await user.click(screen.getByRole('button', { name: 'Reset data…' }));
        const dialog = screen.getByRole('alertdialog', { name: 'Reset all game data?' });
        expect(dialog).toHaveTextContent("It can't be undone.");
        await user.click(screen.getByRole('button', { name: 'Delete everything' }));

        expect(fake.launcher.resetData).toHaveBeenCalledTimes(1);
        expect(await screen.findByText('All game data was deleted.')).toBeInTheDocument();
    });

    test('Cancel deletes nothing', async () => {
        const { fake, user } = await openSettings();

        await user.click(screen.getByRole('button', { name: 'Reset data…' }));
        await user.click(screen.getByRole('button', { name: 'Cancel' }));

        expect(fake.launcher.resetData).not.toHaveBeenCalled();
        expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });

    test('is disabled while hosting, with the reason', async () => {
        await openSettings({ snapshot: { status: 'hosting', url: TUNNEL_URL } });

        const button = screen.getByRole('button', { name: 'Reset data…' });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription('Stop hosting first.');
        expect(screen.getByText('Changes apply the next time you start hosting.')).toBeInTheDocument();
    });

    test('is disabled after a failure until the error is dismissed', async () => {
        await openSettings({ snapshot: { status: 'failed', error: 'Tunnel exited' } });

        const button = screen.getByRole('button', { name: 'Reset data…' });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription('Dismiss the error on Home first.');
        expect(screen.queryByText('Changes apply the next time you start hosting.')).not.toBeInTheDocument();
    });

    test('shows why a reset was refused', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.resetData.mockResolvedValue({ ok: false, error: 'Stop hosting before resetting data' });

        await user.click(screen.getByRole('button', { name: 'Reset data…' }));
        await user.click(screen.getByRole('button', { name: 'Delete everything' }));

        expect(await screen.findByText('Stop hosting before resetting data')).toBeInTheDocument();
    });

    test('a reset that fails says so', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.resetData.mockRejectedValue(new Error('the database is locked'));

        await user.click(screen.getByRole('button', { name: 'Reset data…' }));
        await user.click(screen.getByRole('button', { name: 'Delete everything' }));

        expect(await screen.findByText("Couldn't reset the data: the database is locked")).toBeInTheDocument();
    });

    test('is disabled until the hosting status is known', async () => {
        const fake = createFakeLauncher();
        fake.launcher.getState.mockImplementation(() => new Promise(() => {}));
        const user = userEvent.setup();
        render(<LauncherApp launcher={fake.launcher} />);

        await user.click(screen.getByRole('tab', { name: 'Settings' }));
        await screen.findByLabelText('Gemini API key');

        const button = screen.getByRole('button', { name: 'Reset data…' });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription('Checking whether the game is being hosted…');
        expect(screen.queryByText('Changes apply the next time you start hosting.')).not.toBeInTheDocument();
    });
});

// --- Loading -------------------------------------------------------------------------------

test('settings that fail to load say so', async () => {
    const fake = createFakeLauncher();
    fake.launcher.getSettings.mockRejectedValue(new Error('settings.json is unreadable'));
    const user = userEvent.setup();
    render(<LauncherApp launcher={fake.launcher} />);

    await user.click(screen.getByRole('tab', { name: 'Settings' }));

    expect(await screen.findByText("Couldn't load the settings: settings.json is unreadable")).toBeInTheDocument();
});

// --- About ---------------------------------------------------------------------------------

describe('the About section', () => {
    test('shows the unofficial disclaimer word for word', async () => {
        await openSettings();

        const about = screen.getByRole('region', { name: 'About' });
        expect(about).toHaveTextContent(UNOFFICIAL_DISCLAIMER);
        expect(UNOFFICIAL_DISCLAIMER).toBe(
            'Flip Showdown is an unofficial score keeper. It is not affiliated with, endorsed by or sponsored by '
            + 'The Op Games. Flip 7 is a trademark of its owner.',
        );
    });

    test('opens the licence, the third-party notices and cloudflared\'s licence', async () => {
        const { fake, user } = await openSettings();

        await user.click(screen.getByRole('button', { name: 'Licence (MIT)' }));
        await user.click(screen.getByRole('button', { name: 'Third-party notices' }));
        await user.click(screen.getByRole('button', { name: 'cloudflared licence (Apache-2.0)' }));

        expect(fake.launcher.openLicense.mock.calls).toEqual([['app'], ['third-party'], ['cloudflared']]);
    });

    test('says so when a licence file cannot be opened', async () => {
        const { user } = await openSettings({ openLicenseResult: { ok: false, error: "Couldn't open the file: missing" } });

        await user.click(screen.getByRole('button', { name: 'Third-party notices' }));

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open the file: missing");
    });

    test('reports a bridge failure as an error', async () => {
        const { fake, user } = await openSettings();
        fake.launcher.openLicense.mockRejectedValue(new Error('IPC down'));

        await user.click(screen.getByRole('button', { name: 'Licence (MIT)' }));

        expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open the file: IPC down");
    });
});

test('card scanning names Google\'s Gemini API terms where the key is entered (X69)', async () => {
    await openSettings();

    const scanning = screen.getByRole('region', { name: 'Card scanning (optional)' });
    expect(within(scanning).getByText(/Gemini API terms, including their age and region rules.*free tier, Google may use the photos/))
        .toBeInTheDocument();
});
