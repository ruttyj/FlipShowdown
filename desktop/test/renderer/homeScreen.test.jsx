import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { describe, expect, test, vi } from 'vitest';
import LauncherApp from '../../src/renderer/LauncherApp.jsx';
import { createFakeLauncher, makeSnapshot, NEW_TUNNEL_URL, TUNNEL_URL } from './fakeLauncher.jsx';

const HOSTING = { status: 'hosting', port: 7007, url: TUNNEL_URL };

/** Renders the launcher and waits for the first snapshot to be shown. */
async function renderLauncher(options) {
    const fake = createFakeLauncher(options);
    const user = userEvent.setup();
    const view = render(<LauncherApp launcher={fake.launcher} />);
    await screen.findByText(/^Server: /);
    return { fake, user, view };
}

function statusRegion() {
    return screen.getByText(/^Server: /);
}

function linkChangedAnnouncement() {
    return screen.getByTestId('link-changed-announcement');
}

function batteryAnnouncement() {
    return screen.getByTestId('battery-announcement');
}

// --- Start and stop ------------------------------------------------------------------------

describe('start and stop', () => {
    test('idle shows Start hosting and both chips off', async () => {
        await renderLauncher();

        expect(screen.getByRole('button', { name: 'Start hosting' })).toBeEnabled();
        expect(statusRegion()).toHaveTextContent('Server: Stopped. Tunnel: Off.');
        expect(screen.queryByRole('img', { name: /QR code/ })).not.toBeInTheDocument();
        expect(screen.getByText('The QR code and link show here once hosting starts.')).toBeInTheDocument();
    });

    test('Start hosting starts the session, and the pushed states update the chips', async () => {
        const { fake, user } = await renderLauncher();

        await user.click(screen.getByRole('button', { name: 'Start hosting' }));
        expect(fake.launcher.start).toHaveBeenCalledTimes(1);

        fake.emitState({ status: 'starting-server' });
        expect(statusRegion()).toHaveTextContent('Server: Starting. Tunnel: Waiting.');
        expect(screen.getByRole('button', { name: 'Stop hosting' })).toBeEnabled();

        fake.emitState({ status: 'starting-tunnel', port: 7007 });
        expect(statusRegion()).toHaveTextContent('Server: Running. Tunnel: Connecting.');
    });

    test('a chip shows a spinner while its part is starting, and a dot once it is up (X75)', async () => {
        const { fake, view } = await renderLauncher();
        const spinningChips = () => [...view.container.querySelectorAll('.launcher-chip-spinner')]
            .map((spinner) => spinner.closest('.launcher-chip').textContent);
        expect(spinningChips()).toEqual([]);

        fake.emitState({ status: 'starting-server' });
        expect(spinningChips()).toEqual(['ServerStarting', 'TunnelWaiting']);

        fake.emitState({ status: 'starting-tunnel', port: 7007 });
        expect(spinningChips()).toEqual(['TunnelConnecting']);

        fake.emitState({ status: 'tunnel-restarting', port: 7007, retry: null });
        expect(spinningChips()).toEqual(['TunnelReconnecting']);

        fake.emitState(HOSTING);
        expect(spinningChips()).toEqual([]);
    });

    test('a start still pending while states are pushed ends on the hosting snapshot it resolves with', async () => {
        const { fake, user } = await renderLauncher();
        let isStartSettled = false;

        await user.click(screen.getByRole('button', { name: 'Start hosting' }));
        fake.launcher.start.mock.results[0].value.then(() => {
            isStartSettled = true;
        });
        fake.emitState({ status: 'starting-server' });
        fake.emitState({ status: 'starting-tunnel', port: 7007 });
        await Promise.resolve();
        expect(isStartSettled).toBe(false);
        expect(statusRegion()).toHaveTextContent('Server: Running. Tunnel: Connecting.');

        fake.emitState({ status: 'hosting', url: TUNNEL_URL });

        await waitFor(() => expect(isStartSettled).toBe(true));
        expect(statusRegion()).toHaveTextContent('Tunnel: Connected.');
        expect(screen.getByLabelText('Game link')).toHaveValue(TUNNEL_URL);
    });

    test('Stop clicked while a start is pending ends idle once the start resolves', async () => {
        const { fake, user } = await renderLauncher();
        fake.launcher.stop.mockResolvedValue(makeSnapshot());

        await user.click(screen.getByRole('button', { name: 'Start hosting' }));
        fake.emitState({ status: 'starting-server' });
        await user.click(screen.getByRole('button', { name: 'Stop hosting' }));
        fake.emitState({ status: 'idle' });

        expect(await screen.findByRole('button', { name: 'Start hosting' })).toBeEnabled();
        expect(statusRegion()).toHaveTextContent('Server: Stopped. Tunnel: Off.');
    });

    test('a start that fails says so', async () => {
        const { fake, user } = await renderLauncher();
        fake.launcher.start.mockRejectedValue(new Error('IPC channel closed'));

        await user.click(screen.getByRole('button', { name: 'Start hosting' }));

        expect(await screen.findByText("Couldn't start hosting: IPC channel closed")).toBeInTheDocument();
    });

    test('the status sentence is announced politely', async () => {
        await renderLauncher();

        expect(statusRegion()).toHaveAttribute('aria-live', 'polite');
    });

    test('Stop hosting stops the session and shows the idle snapshot it resolves with', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });
        fake.launcher.stop.mockResolvedValue(makeSnapshot());

        await user.click(screen.getByRole('button', { name: 'Stop hosting' }));

        expect(fake.launcher.stop).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole('button', { name: 'Start hosting' })).toBeInTheDocument();
    });

    test('while stopping the button is disabled', async () => {
        const { fake } = await renderLauncher({ snapshot: HOSTING });

        fake.emitState({ status: 'stopping', url: null });

        expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled();
    });

    test('a stop that fails says so', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });
        fake.launcher.stop.mockRejectedValue(new Error('cloudflared would not exit'));

        await user.click(screen.getByRole('button', { name: 'Stop hosting' }));

        expect(await screen.findByText("Couldn't stop hosting: cloudflared would not exit")).toBeInTheDocument();
    });

    test('a state pushed before getState resolves is not overwritten by the older reply', async () => {
        const fake = createFakeLauncher();
        let resolveState;
        fake.launcher.getState.mockImplementation(() => new Promise((resolve) => {
            resolveState = resolve;
        }));
        render(<LauncherApp launcher={fake.launcher} />);

        fake.emitState({ status: 'hosting', url: TUNNEL_URL });
        resolveState(makeSnapshot());

        await waitFor(() => expect(statusRegion()).toHaveTextContent('Tunnel: Connected.'));
    });

    test('unmounting removes every subscription', async () => {
        const { fake, view } = await renderLauncher();

        view.unmount();

        expect(fake.listenerCount()).toBe(0);
    });
});

// --- Game link -----------------------------------------------------------------------------

describe('the game link', () => {
    test('hosting shows the QR code and the link', async () => {
        await renderLauncher({ snapshot: HOSTING });

        const qrCode = await screen.findByRole('img', { name: 'QR code for the game link' });
        expect(qrCode.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
        expect(screen.getByLabelText('Game link')).toHaveValue(TUNNEL_URL);
        expect(screen.queryByText(/once hosting starts/)).not.toBeInTheDocument();
        expect(statusRegion()).toHaveTextContent('Tunnel: Connected.');
    });

    // X65: white modules on a clear background, on the lobby's gradient card.
    test('the QR code is white on a clear background', async () => {
        await renderLauncher({ snapshot: HOSTING });

        const qrCode = await screen.findByRole('img', { name: 'QR code for the game link' });
        const svg = decodeURIComponent(qrCode.getAttribute('src'));
        expect(svg).toContain('stroke="#ffffff"');
        expect(svg).not.toContain('#000000');
    });

    test('a QR code that cannot be drawn points to the link instead', async () => {
        // Far more than a QR code holds.
        const tooLong = `${TUNNEL_URL}/${'x'.repeat(5000)}`;
        await renderLauncher({ snapshot: { ...HOSTING, url: tooLong } });

        expect(await screen.findByText("Couldn't draw the QR code. Share the link below instead.")).toBeInTheDocument();
    });

    test('Copy puts the link on the clipboard and confirms it', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING });

        await user.click(screen.getByRole('button', { name: 'Copy link' }));

        expect(await navigator.clipboard.readText()).toBe(TUNNEL_URL);
        expect(screen.getByText('Link copied.')).toBeInTheDocument();
    });

    test('a failed copy asks the user to copy it by hand', async () => {
        const { user } = await renderLauncher({ snapshot: HOSTING });
        // A spy, not an assignment: restoreMocks undoes it, so later copies in this file work.
        vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));

        await user.click(screen.getByRole('button', { name: 'Copy link' }));

        expect(await screen.findByText("Couldn't copy the link. Select it and copy it by hand.")).toBeInTheDocument();
    });

    test('Open game asks the main process to open it, showing progress meanwhile', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });
        let finishOpening;
        fake.launcher.openGame.mockImplementation(() => new Promise((resolve) => {
            finishOpening = resolve;
        }));

        await user.click(screen.getByRole('button', { name: 'Open game' }));

        expect(screen.getByRole('button', { name: 'Opening…' })).toBeDisabled();
        finishOpening({ ok: true });
        expect(await screen.findByRole('button', { name: 'Open game' })).toBeEnabled();
        expect(fake.launcher.openGame).toHaveBeenCalledTimes(1);
    });

    test('Open game shows why it could not open', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });
        fake.launcher.openGame.mockResolvedValue({ ok: false, error: 'The link changed while waiting' });

        await user.click(screen.getByRole('button', { name: 'Open game' }));

        expect(await screen.findByText('The link changed while waiting')).toBeInTheDocument();
    });

    test('Open game that fails to open says why and can be tried again', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });
        fake.launcher.openGame.mockRejectedValue(new Error('No browser is set up'));

        await user.click(screen.getByRole('button', { name: 'Open game' }));

        expect(await screen.findByText("Couldn't open the game: No browser is set up")).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open game' })).toBeEnabled();
    });

    test('a message about the old link is cleared when the link changes', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });
        await user.click(screen.getByRole('button', { name: 'Copy link' }));
        expect(screen.getByText('Link copied.')).toBeInTheDocument();

        fake.emitState({ url: NEW_TUNNEL_URL, previousUrl: TUNNEL_URL });

        expect(screen.getByLabelText('Game link')).toHaveValue(NEW_TUNNEL_URL);
        expect(screen.queryByText('Link copied.')).not.toBeInTheDocument();
    });

    test('while the tunnel reconnects the link is hidden and the attempt shown', async () => {
        const { fake } = await renderLauncher({ snapshot: HOSTING });

        fake.emitState({ status: 'tunnel-restarting', url: null, retry: { attempt: 1, maxRetries: 3, delayMs: 1000 } });

        expect(screen.queryByLabelText('Game link')).not.toBeInTheDocument();
        expect(statusRegion()).toHaveTextContent('Tunnel: Reconnecting (attempt 1 of 3).');
    });
});

// --- URL changed ---------------------------------------------------------------------------

describe('the "URL changed" banner', () => {
    test('a new link asks everyone to rescan, and Dismiss hides it', async () => {
        const { fake, user } = await renderLauncher({ snapshot: HOSTING });

        fake.emitUrlChanged({ previousUrl: TUNNEL_URL, url: NEW_TUNNEL_URL });
        fake.emitState({ url: NEW_TUNNEL_URL, previousUrl: TUNNEL_URL });

        const banner = screen.getByRole('region', { name: 'Link changed' });
        expect(banner).toHaveTextContent('The game link changed. Everyone needs to scan the new QR code.');
        await user.click(within(banner).getByRole('button', { name: 'Dismiss' }));
        expect(screen.queryByRole('region', { name: 'Link changed' })).not.toBeInTheDocument();
    });

    test('the change is announced through a live region that was already on the page', async () => {
        const { fake } = await renderLauncher({ snapshot: HOSTING });
        const announcement = linkChangedAnnouncement();
        expect(announcement).toHaveAttribute('role', 'status');
        expect(announcement).toBeEmptyDOMElement();

        fake.emitUrlChanged({ previousUrl: TUNNEL_URL, url: NEW_TUNNEL_URL });

        expect(linkChangedAnnouncement()).toBe(announcement);
        expect(announcement).toHaveTextContent('The game link changed. Everyone needs to scan the new QR code.');
    });

    test('the first link of a session is not a change', async () => {
        const { fake } = await renderLauncher({ snapshot: { status: 'starting-tunnel' } });

        fake.emitUrlChanged({ previousUrl: null, url: TUNNEL_URL });

        expect(screen.queryByRole('region', { name: 'Link changed' })).not.toBeInTheDocument();
        expect(linkChangedAnnouncement()).toBeEmptyDOMElement();
    });

    test('stopping clears the banner, so the next session starts without it', async () => {
        const { fake } = await renderLauncher({ snapshot: HOSTING });
        fake.emitUrlChanged({ previousUrl: TUNNEL_URL, url: NEW_TUNNEL_URL });
        expect(screen.getByRole('region', { name: 'Link changed' })).toBeInTheDocument();

        fake.emitState({ status: 'stopping', url: null });
        fake.emitState({ status: 'idle' });
        fake.emitState({ status: 'hosting', url: TUNNEL_URL });

        expect(screen.queryByRole('region', { name: 'Link changed' })).not.toBeInTheDocument();
        expect(linkChangedAnnouncement()).toBeEmptyDOMElement();
    });
});

// --- Failure -------------------------------------------------------------------------------

describe('the error state', () => {
    const FAILED = {
        status: 'failed',
        error: 'The tunnel failed 3 times',
        serverLog: ['server listening on 7007'],
        tunnelLog: ['ERR failed to connect', 'ERR giving up'],
    };

    test('shows the reason and no Start button', async () => {
        await renderLauncher({ snapshot: FAILED });

        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Hosting stopped');
        expect(alert).toHaveTextContent('The tunnel failed 3 times');
        expect(screen.queryByRole('button', { name: 'Start hosting' })).not.toBeInTheDocument();
        expect(statusRegion()).toHaveTextContent('Server: Stopped. Tunnel: Stopped.');
    });

    test('Retry asks the session to start again', async () => {
        const { fake, user } = await renderLauncher({ snapshot: FAILED });

        await user.click(screen.getByRole('button', { name: 'Retry' }));

        expect(fake.launcher.retry).toHaveBeenCalledTimes(1);
    });

    test('a retry that fails says so', async () => {
        const { fake, user } = await renderLauncher({ snapshot: FAILED });
        fake.launcher.retry.mockRejectedValue(new Error('IPC channel closed'));

        await user.click(screen.getByRole('button', { name: 'Retry' }));

        expect(await screen.findByText("Couldn't retry: IPC channel closed")).toBeInTheDocument();
    });

    test('Dismiss clears the error by stopping the session, back to Start hosting', async () => {
        const { fake, user } = await renderLauncher({ snapshot: FAILED });
        fake.launcher.stop.mockResolvedValue(makeSnapshot());

        await user.click(screen.getByRole('button', { name: 'Dismiss' }));

        expect(fake.launcher.stop).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole('button', { name: 'Start hosting' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    test('Show logs reveals the last server and tunnel lines', async () => {
        const { user } = await renderLauncher({ snapshot: FAILED });
        const toggle = screen.getByRole('button', { name: 'Show logs' });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');

        await user.click(toggle);

        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'Hide logs' })).toBe(toggle);
        expect(screen.getByLabelText('Server output')).toHaveTextContent('server listening on 7007');
        expect(screen.getByLabelText('Tunnel output')).toHaveTextContent('ERR failed to connect ERR giving up');
    });

    test('the logs keep only the last 50 lines and say when there are none', async () => {
        const manyLines = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`);
        const { user } = await renderLauncher({ snapshot: { ...FAILED, serverLog: manyLines, tunnelLog: [] } });

        await user.click(screen.getByRole('button', { name: 'Show logs' }));

        const serverOutput = screen.getByLabelText('Server output');
        expect(serverOutput).not.toHaveTextContent(/line 10\b/);
        expect(serverOutput).toHaveTextContent('line 11');
        expect(serverOutput).toHaveTextContent('line 60');
        expect(screen.getByLabelText('Tunnel output')).toHaveTextContent('No output.');
    });

    test('a failure without a reason still says hosting stopped', async () => {
        await renderLauncher({ snapshot: { status: 'failed' } });

        expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong.');
    });
});

// --- Power ---------------------------------------------------------------------------------

describe('power hints', () => {
    test('always reminds the host to keep the lid open and plug in', async () => {
        await renderLauncher();

        expect(screen.getByText('Keep the lid open and the laptop plugged in while people play.')).toBeInTheDocument();
    });

    test('warns while on battery, and the warning follows the power status', async () => {
        const { fake } = await renderLauncher({ power: { onBattery: true } });
        const warning = 'This computer is on battery. Plug it in: hosting keeps it awake and drains the battery.';

        // The live region holds the same text, so look only at the visible warning.
        const notAnnouncement = { ignore: '[role="status"]' };

        expect(await screen.findByText(warning, notAnnouncement)).toBeInTheDocument();

        fake.emitPowerStatus({ onBattery: false });
        expect(screen.queryByText(warning, notAnnouncement)).not.toBeInTheDocument();
    });

    test('the battery warning is announced through a live region that was already on the page', async () => {
        const { fake } = await renderLauncher();
        const announcement = batteryAnnouncement();
        expect(announcement).toHaveAttribute('role', 'status');
        expect(announcement).toBeEmptyDOMElement();

        fake.emitPowerStatus({ onBattery: true });

        expect(batteryAnnouncement()).toBe(announcement);
        expect(announcement).toHaveTextContent('This computer is on battery.');
    });
});

// --- Service terms -------------------------------------------------------------------------

test('the hosting panel says the link is a Cloudflare Quick Tunnel under Cloudflare\'s terms (X69)', async () => {
    await renderLauncher();

    const hosting = screen.getByRole('region', { name: 'Hosting' });
    expect(within(hosting).getByText(/free Cloudflare Quick Tunnel.*no uptime guarantee.*Cloudflare's terms apply/))
        .toBeInTheDocument();
});
