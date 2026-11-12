// Which game mode the screen shows, as an attribute on <html> because dialogs portal to <body>.
// When the room's mode changes, every phone plays the same shift: a layer covers the screen, the
// theme swaps underneath it, and the layer fades out (ModeShift draws it). The server's update drives
// this, not the tap, so nobody sees a shift that then fails.

import { useEffect, useLayoutEffect, useState } from 'react';
import { getRules, modeTransition, usesCrossFade } from '@/lib/gameRules';

const THEME_ATTRIBUTE = 'data-game-mode';
// The cross-fade is a plain 200 ms: half in, half out.
const CROSS_FADE_STEP_MS = 100;

/**
 * @typedef {object} ModeShiftState
 * @property {number} id  changes for each shift, so a second change restarts the animation
 * @property {string} from  the mode on screen until the layer has covered it
 * @property {string} to
 * @property {number} coverMs
 * @property {number} fadeMs
 * @property {boolean} isCrossFade  a plain cross-fade with no moving circle
 * @property {boolean} isCovered  the layer has covered the screen, so the theme has swapped
 */

function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The mode to show: the one being left until the shift has covered the screen. */
function shownMode(shift, mode) {
    if (shift && !shift.isCovered) {
        return shift.from;
    }
    return mode;
}

/** @returns {ModeShiftState} */
function createShift({ previousShift, from, to }) {
    const isCrossFade = usesCrossFade({ prefersReducedMotion: prefersReducedMotion() });
    const { coverMs, fadeMs } = getRules(to).mood;

    return {
        id: (previousShift?.id ?? 0) + 1,
        from,
        to,
        coverMs: isCrossFade ? CROSS_FADE_STEP_MS : coverMs,
        fadeMs: isCrossFade ? CROSS_FADE_STEP_MS : fadeMs,
        isCrossFade,
        isCovered: false,
    };
}

/**
 * @param {object} room
 * @param {string|null} room.roomId
 * @param {string|null} room.mode  the room's mode id, or null until a room has loaded, which leaves
 *        the page neutral rather than flashing classic
 * @returns {{themeMode: string|null, modeShift: ModeShiftState|null}}
 */
export function useGameModeTheme({ roomId, mode }) {
    const [tracked, setTracked] = useState({ roomId, mode });
    const [shift, setShift] = useState(null);

    // Set during render, not in an effect, so the new mode is never painted before the shift starts.
    // Moving to another room isn't a change of mode. A background tab has nobody to show it to.
    if (tracked.roomId !== roomId || tracked.mode !== mode) {
        setTracked({ roomId, mode });

        const isSameRoom = tracked.roomId === roomId;
        const shouldShift = isSameRoom && modeTransition(tracked.mode, mode) !== null && !document.hidden;
        if (shouldShift) {
            setShift(createShift({ previousShift: shift, from: shownMode(shift, tracked.mode), to: mode }));
        } else {
            setShift(null);
        }
    }

    const shiftId = shift?.id;
    useEffect(() => {
        if (shiftId === undefined) {
            return undefined;
        }

        const coverTimer = setTimeout(() => {
            setShift((current) => ({ ...current, isCovered: true }));
        }, shift.coverMs);
        const endTimer = setTimeout(() => {
            setShift(null);
        }, shift.coverMs + shift.fadeMs);

        return () => {
            clearTimeout(coverTimer);
            clearTimeout(endTimer);
        };
        // Only a new shift restarts the timers, not its own isCovered update.
    }, [shiftId]);

    const themeMode = shownMode(shift, mode);

    useLayoutEffect(() => {
        if (themeMode) {
            document.documentElement.setAttribute(THEME_ATTRIBUTE, themeMode);
        } else {
            document.documentElement.removeAttribute(THEME_ATTRIBUTE);
        }
    }, [themeMode]);

    // Leaving the room must not leave Home in its colours.
    useLayoutEffect(() => {
        return () => {
            document.documentElement.removeAttribute(THEME_ATTRIBUTE);
        };
    }, []);

    return { themeMode, modeShift: shift };
}
