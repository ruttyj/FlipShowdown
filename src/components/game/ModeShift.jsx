import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { getRules } from '@/lib/gameRules';

const MILLISECONDS_PER_SECOND = 1000;
// Well past the far corner: a circle's percentage radius is relative to the screen's own size.
const FULL_COVER_RADIUS = '150%';
const ORIGIN_WITHOUT_LOGO = '50% 15%';

/** Where the logo is on screen, for the circle to spread from. */
function logoOrigin() {
    const logo = document.querySelector('[data-game-logo]');
    if (!logo) {
        return ORIGIN_WITHOUT_LOGO;
    }

    const rect = logo.getBoundingClientRect();
    return `${rect.left + rect.width / 2}px ${rect.top + rect.height / 2}px`;
}

/** The timing for opacity keyframes that hold until the screen is covered, then fade out. */
function fadeOut(shift) {
    const totalMs = shift.coverMs + shift.fadeMs;
    return {
        duration: totalMs / MILLISECONDS_PER_SECOND,
        times: [0, shift.coverMs / totalMs, 1],
    };
}

function circleMotion(shift, origin) {
    return {
        initial: { clipPath: `circle(0% at ${origin})`, opacity: 1 },
        animate: { clipPath: `circle(${FULL_COVER_RADIUS} at ${origin})`, opacity: [1, 1, 0] },
        transition: {
            clipPath: { duration: shift.coverMs / MILLISECONDS_PER_SECOND, ease: 'easeOut' },
            opacity: fadeOut(shift),
        },
    };
}

function crossFadeMotion(shift) {
    return {
        initial: { opacity: 0 },
        animate: { opacity: [0, 1, 0] },
        transition: fadeOut(shift),
    };
}

function ShiftLayer({ shift }) {
    // Measured once, as the logo itself swaps partway through.
    const [origin] = useState(logoOrigin);
    const motionProps = shift.isCrossFade ? crossFadeMotion(shift) : circleMotion(shift, origin);
    // The mood's gradient reads the origin, so the glow rolls out from the logo with the circle.
    const layerStyle = /** @type {React.CSSProperties} */ ({
        '--mode-shift-origin': origin,
        background: getRules(shift.to).mood.background,
    });

    return (
        <motion.div
            data-testid="mode-shift"
            aria-hidden="true"
            className="fixed inset-0 z-[45] pointer-events-none"
            style={layerStyle}
            {...motionProps}
        />
    );
}

/**
 * The transition between game modes, on every player's screen at once. It sits above page content
 * and below dialogs and full-size chat emoji, takes no pointer events or focus and is hidden from
 * screen readers, so an open card entry and its keyboard are untouched.
 *
 * @param {{shift: import('@/hooks/useGameModeTheme').ModeShiftState|null}} props
 */
export default function ModeShift({ shift }) {
    if (!shift) {
        return null;
    }
    return <ShiftLayer key={shift.id} shift={shift} />;
}
