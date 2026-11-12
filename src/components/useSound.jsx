import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { readLocalJson, writeLocalJson } from '@/lib/safeStorage';

const MUTE_KEY = 'flip7_sound_muted';

// --- Shared AudioContext -------------------------------------------------
// One context for the whole app. Browsers cap live contexts, and a context
// created outside a tap starts suspended, so it is resumed on the first tap.

let sharedAudioContext = null;

function getAudioContext() {
    if (sharedAudioContext) {
        return sharedAudioContext;
    }
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) {
        return null;
    }
    sharedAudioContext = new AudioContextClass();
    return sharedAudioContext;
}

function unlockAudio() {
    const audioContext = getAudioContext();
    if (audioContext && audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
    }
}

const playTone = (frequency, duration, volume = 0.3, waveType = 'sine') => {
    const audioContext = getAudioContext();
    if (!audioContext) {
        return;
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume().catch(() => {});
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = frequency;
    oscillator.type = waveType;

    gainNode.gain.setValueAtTime(volume, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + duration);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + duration);
};

// --- Chimes --------------------------------------------------------------

export const playChimeWaitingRoom = (isMuted) => {
    if (isMuted) {
        return;
    }
    setTimeout(() => playTone(523.25, 0.12, 0.3), 0);     // C5
    setTimeout(() => playTone(659.25, 0.12, 0.3), 120);   // E5
    setTimeout(() => playTone(783.99, 0.25, 0.3), 240);   // G5
};

export const playChimeGameStart = (isMuted) => {
    if (isMuted) {
        return;
    }
    setTimeout(() => playTone(659.25, 0.1, 0.3), 0);      // E5
    setTimeout(() => playTone(783.99, 0.1, 0.3), 110);    // G5
    setTimeout(() => playTone(1046.50, 0.25, 0.3), 220);  // C6
};

export const playChimeGameEnd = (isMuted) => {
    if (isMuted) {
        return;
    }
    setTimeout(() => playTone(1046.50, 0.15, 0.3), 0);    // C6
    setTimeout(() => playTone(783.99, 0.15, 0.3), 160);   // G5
    setTimeout(() => playTone(659.25, 0.15, 0.3), 320);   // E5
    setTimeout(() => playTone(783.99, 0.3, 0.3), 480);    // G5
};

// A soft bell, unlike the bright game chimes: two triangle tones together, then a quieter echo (X64).
export const playChimeNewRound = (isMuted) => {
    if (isMuted) {
        return;
    }
    playTone(1318.51, 0.6, 0.12, 'triangle');                         // E6
    playTone(987.77, 0.6, 0.12, 'triangle');                          // B5
    setTimeout(() => playTone(1318.51, 0.5, 0.08, 'triangle'), 180);  // E6 echo
};

export const playSuccess = (isMuted) => {
    if (isMuted) {
        return;
    }
    // Ascending tones
    setTimeout(() => playTone(523.25, 0.1, 0.25), 0);     // C5
    setTimeout(() => playTone(659.25, 0.1, 0.25), 75);    // E5
    setTimeout(() => playTone(783.99, 0.2, 0.25), 150);   // G5
};

// --- Shared mute state ---------------------------------------------------

const SoundContext = createContext(null);

export function SoundProvider({ children }) {
    const [isMuted, setIsMuted] = useState(() => readLocalJson(MUTE_KEY, false) === true);
    const isMutedRef = useRef(isMuted);

    useEffect(() => {
        isMutedRef.current = isMuted;
        writeLocalJson(MUTE_KEY, isMuted);
    }, [isMuted]);

    useEffect(() => {
        window.addEventListener('pointerdown', unlockAudio, { once: true });
        return () => window.removeEventListener('pointerdown', unlockAudio);
    }, []);

    const toggleMute = useCallback(() => {
        setIsMuted(previous => !previous);
    }, []);

    // The play functions are stable and read the live mute flag, so a chime
    // scheduled from an old render still respects the current toggle.
    const value = useMemo(() => ({
        isMuted,
        toggleMute,
        playChimeWaitingRoom: () => playChimeWaitingRoom(isMutedRef.current),
        playChimeGameStart: () => playChimeGameStart(isMutedRef.current),
        playChimeGameEnd: () => playChimeGameEnd(isMutedRef.current),
        playChimeNewRound: () => playChimeNewRound(isMutedRef.current),
        playSuccess: () => playSuccess(isMutedRef.current),
    }), [isMuted, toggleMute]);

    return <SoundContext.Provider value={value}>{children}</SoundContext.Provider>;
}

export const useSound = () => {
    const context = useContext(SoundContext);
    if (!context) {
        throw new Error('useSound must be used inside <SoundProvider>');
    }
    return context;
};
