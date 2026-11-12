import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import LauncherApp from '../../src/renderer/LauncherApp.jsx';
import { createFakeLauncher } from './fakeLauncher.jsx';

const RELEASE_URL = 'https://github.com/ruttyj/FlipShowdown/releases/tag/v1.2.0';

afterEach(() => {
    document.documentElement.classList.remove('dark');
});

// --- Layout --------------------------------------------------------------------------------

describe('layout', () => {
    test('has a heading, the app version and Home selected', async () => {
        const fake = createFakeLauncher({ version: '1.4.2' });
        render(<LauncherApp launcher={fake.launcher} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Flip Showdown' })).toBeInTheDocument();
        expect(await screen.findByText('Version 1.4.2')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveAttribute('aria-selected', 'true');
    });

    test('draws its own draggable title strip, hidden from screen readers', () => {
        const fake = createFakeLauncher();
        const { container } = render(<LauncherApp launcher={fake.launcher} />);

        const titleBar = container.querySelector('.launcher-titlebar');
        expect(titleBar).toHaveTextContent('Flip Showdown');
        expect(titleBar).toHaveAttribute('aria-hidden', 'true');
    });

    test('a version or power status that cannot be read is left out', async () => {
        const fake = createFakeLauncher();
        fake.launcher.getAppInfo.mockRejectedValue(new Error('IPC channel closed'));
        fake.launcher.getPowerStatus.mockRejectedValue(new Error('IPC channel closed'));
        render(<LauncherApp launcher={fake.launcher} />);

        await screen.findByText(/^Server: /);

        expect(screen.queryByText(/^Version /)).not.toBeInTheDocument();
        expect(screen.getByTestId('battery-announcement')).toBeEmptyDOMElement();
    });

    test('the tabs can be switched with the keyboard', async () => {
        const fake = createFakeLauncher();
        const user = userEvent.setup();
        render(<LauncherApp launcher={fake.launcher} />);

        await user.tab();
        expect(screen.getByRole('tab', { name: 'Home' })).toHaveFocus();
        await user.keyboard('{ArrowRight}');

        expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
        expect(await screen.findByLabelText('Gemini API key')).toBeInTheDocument();
    });
});

// --- Theme ---------------------------------------------------------------------------------

describe('theme', () => {
    function stubColorScheme(isDark) {
        const listeners = new Set();
        const query = {
            matches: isDark,
            addEventListener: (_type, listener) => listeners.add(listener),
            removeEventListener: (_type, listener) => listeners.delete(listener),
        };
        vi.spyOn(window, 'matchMedia').mockReturnValue(/** @type {any} */ (query));
        return {
            listeners,
            change(nextIsDark) {
                query.matches = nextIsDark;
                act(() => {
                    for (const listener of listeners) {
                        listener();
                    }
                });
            },
        };
    }

    // X65: the launcher is always the Classic look, so the system theme changes nothing.
    test('stays in the Classic look whatever the system colour scheme', () => {
        stubColorScheme(true);
        const view = render(<LauncherApp launcher={createFakeLauncher().launcher} />);

        expect(document.documentElement).not.toHaveClass('dark');
        expect(view.container.firstElementChild).toHaveAttribute('data-game-mode', 'classic');
    });
});

// --- Update banner -------------------------------------------------------------------------

describe('the update banner', () => {
    test('stays hidden when the app is up to date', async () => {
        const fake = createFakeLauncher();
        render(<LauncherApp launcher={fake.launcher} />);

        await screen.findByText(/^Server: /);

        expect(fake.launcher.checkForUpdate).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('region', { name: 'Update available' })).not.toBeInTheDocument();
    });

    test('names the new version and opens its release page', async () => {
        const fake = createFakeLauncher();
        fake.launcher.checkForUpdate.mockResolvedValue({ updateAvailable: true, latestVersion: '1.2.0', url: RELEASE_URL });
        const user = userEvent.setup();
        render(<LauncherApp launcher={fake.launcher} />);

        const banner = await screen.findByRole('region', { name: 'Update available' });
        expect(banner).toHaveTextContent('Version 1.2.0 is available.');
        await user.click(screen.getByRole('button', { name: 'Download' }));

        expect(fake.launcher.openExternal).toHaveBeenCalledWith(RELEASE_URL);
    });

    test('is announced through a live region that was already on the page', async () => {
        const fake = createFakeLauncher();
        let resolveCheck;
        fake.launcher.checkForUpdate.mockImplementation(() => new Promise((resolve) => {
            resolveCheck = resolve;
        }));
        render(<LauncherApp launcher={fake.launcher} />);
        const announcement = screen.getByTestId('update-announcement');
        expect(announcement).toHaveAttribute('role', 'status');
        expect(announcement).toBeEmptyDOMElement();

        await act(async () => {
            resolveCheck({ updateAvailable: true, latestVersion: '1.2.0', url: RELEASE_URL });
        });

        expect(screen.getByTestId('update-announcement')).toBe(announcement);
        expect(announcement).toHaveTextContent('Version 1.2.0 is available.');
    });

    test('a download page that fails to open says so', async () => {
        const fake = createFakeLauncher();
        fake.launcher.checkForUpdate.mockResolvedValue({ updateAvailable: true, latestVersion: '1.2.0', url: RELEASE_URL });
        fake.launcher.openExternal.mockRejectedValue(new Error('No browser is set up'));
        const user = userEvent.setup();
        render(<LauncherApp launcher={fake.launcher} />);

        await screen.findByRole('region', { name: 'Update available' });
        await user.click(screen.getByRole('button', { name: 'Download' }));

        expect(await screen.findByText("Couldn't open the download page: No browser is set up")).toBeInTheDocument();
    });

    test('can be dismissed', async () => {
        const fake = createFakeLauncher();
        fake.launcher.checkForUpdate.mockResolvedValue({ updateAvailable: true, latestVersion: '1.2.0', url: RELEASE_URL });
        const user = userEvent.setup();
        render(<LauncherApp launcher={fake.launcher} />);

        await screen.findByRole('region', { name: 'Update available' });
        await user.click(screen.getByRole('button', { name: 'Dismiss update' }));

        expect(screen.queryByRole('region', { name: 'Update available' })).not.toBeInTheDocument();
    });

    test('a failed check shows nothing', async () => {
        const fake = createFakeLauncher();
        fake.launcher.checkForUpdate.mockRejectedValue(new Error('offline'));
        render(<LauncherApp launcher={fake.launcher} />);

        await screen.findByText(/^Server: /);

        expect(screen.queryByRole('region', { name: 'Update available' })).not.toBeInTheDocument();
    });
});
