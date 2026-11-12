import React, { useEffect, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';

// iPhone Safari has no Fullscreen API for pages, so there the button is hidden. Older Safari
// only has the webkit-prefixed variants.
function isFullscreenSupported() {
    if (typeof document === 'undefined') {
        return false;
    }

    const root = document.documentElement;
    return Boolean(root.requestFullscreen || root.webkitRequestFullscreen);
}

function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function enterFullscreen() {
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    return request.call(root);
}

function exitFullscreen() {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    return exit.call(document);
}

export default function FullscreenToggle() {
    const [isFullscreen, setIsFullscreen] = useState(() => {
        return isFullscreenSupported() && getFullscreenElement() !== null;
    });

    useEffect(() => {
        const sync = () => {
            setIsFullscreen(getFullscreenElement() !== null);
        };
        document.addEventListener('fullscreenchange', sync);
        document.addEventListener('webkitfullscreenchange', sync);
        return () => {
            document.removeEventListener('fullscreenchange', sync);
            document.removeEventListener('webkitfullscreenchange', sync);
        };
    }, []);

    if (!isFullscreenSupported()) {
        return null;
    }

    const handleToggle = async () => {
        try {
            if (getFullscreenElement()) {
                await exitFullscreen();
            } else {
                await enterFullscreen();
            }
        } catch {
            // The browser refused (e.g. not a user gesture); the button state stays as it was.
        }
    };

    const label = isFullscreen ? 'Exit full screen' : 'Enter full screen';
    const Icon = isFullscreen ? Minimize2 : Maximize2;

    // A bare icon pinned to the top-right corner, deliberately unlike the round buttons
    // stacked at the bottom right.
    return (
        <button
            type="button"
            onClick={handleToggle}
            className="fixed top-[calc(env(safe-area-inset-top)+0.5rem)] right-[calc(env(safe-area-inset-right)+0.5rem)] z-40 p-2 text-white/80 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white rounded"
            aria-label={label}
            title={label}
        >
            <Icon className="w-6 h-6" strokeWidth={3} />
        </button>
    );
}
