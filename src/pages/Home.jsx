import React, { forwardRef, useState, useEffect, useRef } from 'react';
import { backend } from '@/api/backend';
import { game } from '@/api/game';
import { runAction } from '@/lib/runAction';
import { useAuth } from '@/lib/AuthContext';
import { getRules, readLastGameMode, rememberGameMode } from '@/lib/gameRules';
import { UNOFFICIAL_DISCLAIMER } from '@/lib/disclaimer';
import { readLocalJson, removeLocal } from '@/lib/safeStorage';
import {
    CREATE_PARAM,
    DEFAULT_MAX_SCORE,
    GAME_MODE_PARAM,
    MAX_SCORE_PARAM,
    parseMaxScore,
    readCreateAfterLogin,
} from '@/lib/maxScore';
import { createPageUrl } from '@/utils';
import { roomPath } from '@/lib/roomUrl';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, ChevronDown, Loader2, Plus, Settings } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import AccountBar from '@/components/AccountBar';
import QRCodeImage from '@/components/QRCodeImage';
import GameModePicker from '@/components/game/GameModePicker';
import { RulesDialog } from '@/components/game/RulesSheet';
import GameLogo from './gameRoom/GameLogo';
import HeroCards from './home/HeroCards';

const LAST_ROOM_KEY = 'flip7_last_room';

/**
 * Finishes a "Create Room" click that had to go through login first: once signed in, the
 * create request in the URL is removed (so a reload or Back can't create a second room)
 * and the room is created.
 */
function useCreateRoomAfterLogin(user, createRoomNow) {
    const navigate = useNavigate();
    const hasStartedRef = useRef(false);

    useEffect(() => {
        const request = readCreateAfterLogin(window.location.search);
        if (!user || !request || hasStartedRef.current) {
            return;
        }

        hasStartedRef.current = true;
        navigate(createPageUrl('Home'), { replace: true });
        createRoomNow(request.maxScore, request.gameMode);
        // createRoomNow is a fresh function each render; the ref makes this run once.
    }, [user]);
}

/**
 * The code of the room I was last in, if it still exists and I'm still a player in it.
 * Null while unknown or when "Return to game" shouldn't be offered. A room that is gone is
 * forgotten; a failed lookup (offline, server error) keeps the memory for next time.
 */
function useReturnToGameCode(user) {
    const [returnCode, setReturnCode] = useState(null);

    useEffect(() => {
        const remembered = readLocalJson(LAST_ROOM_KEY, null);
        if (!user || !remembered?.code) {
            return undefined;
        }

        let isCancelled = false;
        const checkRoom = async () => {
            try {
                const lookup = await game.lookupRoom(remembered.code);
                if (!isCancelled && lookup.my_player) {
                    setReturnCode(remembered.code);
                }
            } catch (error) {
                if (error?.status === 404) {
                    removeLocal(LAST_ROOM_KEY);
                }
            }
        };
        checkRoom();

        return () => {
            isCancelled = true;
        };
    }, [user]);

    return returnCode;
}

/**
 * The mode the next room will have, above Create Room so it can't be forgotten behind the settings
 * gear. Shows that mode's own small logo, and is the trigger for the mode picker.
 */
const ModeChip = forwardRef(/** @type {React.ForwardRefRenderFunction<HTMLButtonElement, {mode: string} & React.ButtonHTMLAttributes<HTMLButtonElement>>} */ (function ModeChip({ mode, ...triggerProps }, ref) {
    return (
        <button
            ref={ref}
            type="button"
            data-game-mode={mode}
            aria-label={`Game mode: ${getRules(mode).label}`}
            // The fixed height fits the tallest logo, so changing mode doesn't move the buttons below.
            className="game-screen-bg home-chip home-focus group flex items-center gap-3 w-full h-[72px] px-4 rounded-2xl text-left"
            {...triggerProps}
        >
            <GameLogo mode={mode} size="tiny" />
            <span className="flex-1 min-w-0 text-right">
                <span className="block text-[11px] font-semibold uppercase tracking-wider text-white/70">Game mode</span>
                <span className="block text-base font-bold text-white truncate">{getRules(mode).label}</span>
            </span>
            <ChevronDown
                className="shrink-0 w-5 h-5 text-white/70 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                aria-hidden="true"
            />
        </button>
    );
}));

export default function Home() {
    const { user, isLoadingAuth: isLoading } = useAuth();
    const returnCode = useReturnToGameCode(user);
    const [isCreating, setIsCreating] = useState(false);
    const [roomCode, setRoomCode] = useState('');
    const [showSettings, setShowSettings] = useState(false);
    const [maxScore, setMaxScore] = useState(String(DEFAULT_MAX_SCORE));
    const [gameMode, setGameMode] = useState(() => readLastGameMode());
    const [isPickerOpen, setIsPickerOpen] = useState(false);
    // The mode whose rules are showing, or null with the sheet closed.
    const [rulesMode, setRulesMode] = useState(null);
    const fullRulesButtonRef = useRef(null);
    const navigate = useNavigate();

    // Only the chip changes: there is no room to shift, and the choice creates nothing.
    const selectMode = (mode) => {
        setIsPickerOpen(false);
        setGameMode(mode);
        rememberGameMode(mode);
    };

    // The picker stays open under the sheet, and closing the sheet goes back to it.
    const showFullRules = (mode, button) => {
        fullRulesButtonRef.current = button;
        setRulesMode(mode);
    };

    /**
     * @param {number} roomMaxScore
     * @param {string} roomGameMode
     */
    const createRoomNow = async (roomMaxScore, roomGameMode) => {
        // The server picks the room code and adds me as the host player, named after my account.
        const result = await runAction('Create room', () => game.createRoom({
            max_score: roomMaxScore,
            game_mode: roomGameMode,
        }), { setBusy: setIsCreating });
        if (result) {
            navigate(roomPath(result.room.code));
        }
    };

    const createRoom = async () => {
        // The input holds raw text so it can be cleared while typing; it is parsed here.
        const roomMaxScore = parseMaxScore(maxScore);
        if (!user) {
            // Login returns here with the request in the URL, and the room is created then.
            const createRequest = `${CREATE_PARAM}=1&${MAX_SCORE_PARAM}=${roomMaxScore}&${GAME_MODE_PARAM}=${gameMode}`;
            const returnUrl = `${window.location.origin}${createPageUrl(`Home?${createRequest}`)}`;
            backend.auth.redirectToLogin(returnUrl);
            return;
        }

        await createRoomNow(roomMaxScore, gameMode);
    };

    useCreateRoomAfterLogin(user, createRoomNow);

    const joinRoom = async () => {
        if (!roomCode.trim()) {
            return;
        }

        if (!user) {
            const returnUrl = `${window.location.origin}${roomPath(roomCode.toUpperCase())}`;
            backend.auth.redirectToLogin(returnUrl);
            return;
        }

        navigate(roomPath(roomCode.toUpperCase()));
    };

    // Check URL for room code on load
    useEffect(() => {
        const urlParams = new URLSearchParams(window.location.search);
        const codeFromUrl = urlParams.get('code');
        if (codeFromUrl) {
            setRoomCode(codeFromUrl);
        }
    }, []);

    if (isLoading) {
        return (
            <div data-game-mode="classic" className="min-h-screen game-screen-bg home-stage flex items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin text-white" />
            </div>
        );
    }

    const isCustomMaxScore = parseMaxScore(maxScore) !== DEFAULT_MAX_SCORE;

    return (
        <div data-game-mode="classic" className="min-h-screen game-screen-bg home-stage relative overflow-hidden">
            <div className="home-stage-pattern" />

            <div className="absolute top-0 inset-x-0 z-20 flex justify-end p-3 pr-14">
                <AccountBar user={user} />
            </div>

            {/* The bottom padding keeps the last line clear of the sound toggle. */}
            <div className="relative z-10 min-h-screen mx-auto max-w-5xl flex flex-col items-center justify-center gap-7 [@media(max-height:740px)]:gap-5 px-5 pt-[72px] pb-20 lg:flex-row lg:gap-16 lg:pt-20">
                <div className="home-hero w-full max-w-sm text-center">
                    <HeroCards />
                    <GameLogo isBrand size="large" className="home-logo relative" />
                    <p className="home-tagline mt-4 text-[15px] font-medium text-indigo-100/80 [text-wrap:balance]">
                        Scan your hand. Track every round. Crown a winner.
                    </p>
                </div>

                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.15 }}
                    className="w-full max-w-sm space-y-5"
                >
                    {returnCode && (
                        <button
                            type="button"
                            onClick={() => navigate(roomPath(returnCode))}
                            // The code is spaced out on screen, so the name says it as one word.
                            aria-label={`Return to game (${returnCode})`}
                            className="home-resume home-press home-focus flex items-center gap-3 w-full h-16 px-4 rounded-2xl text-left"
                        >
                            <span className="home-live-dot" />
                            <span className="flex-1 min-w-0">
                                <span className="block text-base font-bold leading-tight">Return to game</span>
                                <span className="block font-mono text-sm tracking-[0.18em] text-emerald-50">{returnCode}</span>
                            </span>
                            <ArrowRight className="w-5 h-5 shrink-0" aria-hidden="true" />
                        </button>
                    )}

                    <section aria-labelledby="home-host-heading" className="home-panel p-5 max-[359px]:p-4 space-y-4">
                        <h2 id="home-host-heading" className="home-eyebrow">Host a game</h2>

                        <GameModePicker
                            value={gameMode}
                            open={isPickerOpen}
                            onOpenChange={setIsPickerOpen}
                            onSelect={selectMode}
                            onShowRules={showFullRules}
                            trigger={<ModeChip mode={gameMode} />}
                        />

                        <div className="flex gap-2.5">
                            <button
                                type="button"
                                onClick={createRoom}
                                disabled={isCreating}
                                className="home-cta home-press home-focus flex-1 min-w-0 h-14 px-2 flex items-center justify-center gap-2 rounded-2xl text-base max-[359px]:text-sm font-black uppercase tracking-wider max-[359px]:tracking-normal whitespace-nowrap"
                            >
                                {isCreating ? (
                                    <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                                ) : (
                                    <Plus className="w-5 h-5" strokeWidth={3} aria-hidden="true" />
                                )}
                                Create Room
                            </button>
                            <button
                                type="button"
                                onClick={() => setShowSettings(!showSettings)}
                                aria-label="Game settings"
                                aria-expanded={showSettings}
                                aria-controls="home-settings"
                                className="home-secondary home-press home-focus relative shrink-0 w-14 h-14 flex items-center justify-center rounded-2xl"
                            >
                                <Settings
                                    className={`w-5 h-5 transition-transform duration-300 motion-reduce:transition-none ${showSettings ? 'rotate-90' : ''}`}
                                    aria-hidden="true"
                                />
                                {/* Says a setting behind the gear is doing something while it's closed. */}
                                {isCustomMaxScore && (
                                    <span data-testid="custom-settings-dot" className="absolute top-2 right-2 w-2 h-2 rounded-full bg-amber-400" />
                                )}
                            </button>
                        </div>

                        <div id="home-settings">
                            <AnimatePresence initial={false}>
                                {showSettings && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        exit={{ opacity: 0, height: 0 }}
                                        transition={{ duration: 0.2 }}
                                        className="overflow-hidden"
                                    >
                                        <div className="flex items-center gap-3 pt-1 pb-1">
                                            <label htmlFor="max-score" className="flex-1 text-sm font-medium leading-snug text-indigo-100/90">
                                                Max Score (Game ends when reached)
                                            </label>
                                            <input
                                                type="number"
                                                id="max-score"
                                                value={maxScore}
                                                onChange={(e) => setMaxScore(e.target.value)}
                                                className="home-well w-24 h-12 rounded-xl text-center text-lg font-bold"
                                            />
                                        </div>
                                    </motion.div>
                                )}
                            </AnimatePresence>
                        </div>

                        <div className="home-divider !mt-5" />

                        <h2 id="home-join-heading" className="home-eyebrow !mt-5">Join a game</h2>

                        <div role="group" aria-labelledby="home-join-heading" className="flex gap-2.5">
                            <input
                                placeholder="Enter room code"
                                aria-label="Room code"
                                value={roomCode}
                                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
                                onKeyDown={(e) => {
                                    // joinRoom ignores an empty code itself.
                                    if (e.key === 'Enter') {
                                        joinRoom();
                                    }
                                }}
                                autoCapitalize="characters"
                                autoComplete="off"
                                autoCorrect="off"
                                spellCheck={false}
                                maxLength={6}
                                className="home-well flex-1 min-w-0 h-14 px-2 rounded-2xl text-center text-xl font-mono font-bold tracking-[0.22em]"
                            />
                            <button
                                type="button"
                                onClick={joinRoom}
                                disabled={!roomCode.trim()}
                                aria-label="Join room"
                                className="home-join home-press home-focus shrink-0 h-14 px-5 flex items-center justify-center gap-1.5 rounded-2xl text-sm font-black uppercase tracking-wider"
                            >
                                Join
                                <ArrowRight className="w-4 h-4" strokeWidth={3} aria-hidden="true" />
                            </button>
                        </div>
                    </section>

                    {/* Lets someone at the table open the app on their phone. */}
                    <div className="flex items-center gap-4 px-1">
                        <QRCodeImage
                            url={window.location.origin}
                            size={224}
                            alt="QR code to open Flip Showdown on another device"
                            className="w-28 shrink-0 !mx-0"
                        />
                        <div className="min-w-0 text-sm leading-snug">
                            <p className="font-bold text-white">Everyone at the table?</p>
                            <p className="mt-0.5 text-indigo-100/80">Scan to open on your phone</p>
                            {!user && (
                                <p className="mt-2 text-xs text-indigo-100/70">
                                    You'll be asked to sign in when joining or creating a room
                                </p>
                            )}
                        </div>
                    </div>

                    <footer className="px-1 text-xs leading-snug text-indigo-100/60">
                        {UNOFFICIAL_DISCLAIMER}
                    </footer>
                </motion.div>
            </div>

            <RulesDialog
                open={rulesMode !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setRulesMode(null);
                    }
                }}
                initialMode={rulesMode}
                maxScore={parseMaxScore(maxScore)}
                getReturnFocusTarget={() => fullRulesButtonRef.current}
            />
        </div>
    );
}