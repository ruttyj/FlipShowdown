// Keeps the laptop from sleeping while it hosts a game (decision 6). Only app suspension is
// blocked: the display may still turn off, which saves power and doesn't drop the tunnel.
// Also reports battery power, so the launcher can warn that hosting drains the battery.
//
// Electron's powerSaveBlocker and powerMonitor are injected, so this is tested without Electron.

/**
 * @typedef {object} PowerSaveBlocker  Electron's powerSaveBlocker, or a fake
 * @property {(type: 'prevent-app-suspension') => number} start
 * @property {(id: number) => void} stop
 */

/**
 * @typedef {object} PowerMonitor  Electron's powerMonitor, or a fake
 * @property {() => boolean} isOnBatteryPower
 * @property {(event: string, listener: () => void) => unknown} on
 * @property {(event: string, listener: () => void) => unknown} removeListener
 */

/**
 * @typedef {object} KeepAwake
 * @property {() => void} start   blocks sleep; a second call while active does nothing
 * @property {() => void} stop    lets the system sleep again; safe when not started
 * @property {() => boolean} isOnBattery
 * @property {(listener: (onBattery: boolean) => void) => () => void} onBatteryChange
 *   calls `listener` on every switch between battery and mains power; returns an unsubscribe
 */

/**
 * @param {{ powerSaveBlocker: PowerSaveBlocker, powerMonitor: PowerMonitor }} input
 * @returns {KeepAwake}
 */
export function createKeepAwake({ powerSaveBlocker, powerMonitor }) {
    /** @type {number | null} */
    let blockerId = null;

    function start() {
        if (blockerId !== null) {
            return;
        }

        blockerId = powerSaveBlocker.start('prevent-app-suspension');
    }

    function stop() {
        if (blockerId === null) {
            return;
        }

        powerSaveBlocker.stop(blockerId);
        blockerId = null;
    }

    function isOnBattery() {
        return powerMonitor.isOnBatteryPower();
    }

    /** @param {(onBattery: boolean) => void} listener */
    function onBatteryChange(listener) {
        const report = () => listener(powerMonitor.isOnBatteryPower());
        powerMonitor.on('on-battery', report);
        powerMonitor.on('on-ac', report);

        return () => {
            powerMonitor.removeListener('on-battery', report);
            powerMonitor.removeListener('on-ac', report);
        };
    }

    return { start, stop, isOnBattery, onBatteryChange };
}
