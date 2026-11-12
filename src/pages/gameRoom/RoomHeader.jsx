import React, { useEffect, useRef, useState } from 'react';
import GameModePicker from '@/components/game/GameModePicker';
import { RulesButton, RulesDialog } from '@/components/game/RulesSheet';
import { canChangeMode, getRules } from '@/lib/gameRules';
import { GameLogoButton } from './GameLogo';

/** Why someone can't change the mode, or undefined if they can. */
function readOnlyReason(canChoose, isHost) {
    if (canChoose) {
        return undefined;
    }
    return isHost ? 'This game\'s mode is ticked. It can\'t be changed right now.' : 'This game\'s mode is ticked. Only the host can change it.';
}

/**
 * The Rules button at the bottom of every room screen, kept out of the logo's way. It opens on the
 * room's mode.
 *
 * @param {object} props
 * @param {object} props.room
 */
export function RulesFooter({ room }) {
    return (
        <div className="mt-6 flex justify-center">
            <RulesButton gameMode={room.game_mode} maxScore={room.max_score} />
        </div>
    );
}

/**
 * The top of every room screen: the logo, which opens the mode overlay. Its "Full rules" opens the
 * rules sheet held here; the Rules button is RulesFooter. Everyone can look through the modes. Only a host who can still change the mode can select one;
 * guests and a locked host see the same overlay with nothing to select, and also get the mode's name
 * for screen readers.
 *
 * @param {object} props
 * @param {object} props.room
 * @param {string|null} [props.themeMode]  the mode on screen, which lags the room's during a shift
 * @param {boolean} [props.isHost]
 * @param {object[]} [props.roundScores]  all of the room's RoundScores
 * @param {(mode: string) => void} [props.setGameMode]  the host action
 * @param {string} [props.className]
 */
export default function RoomHeader({ room, themeMode, isHost = false, roundScores = [], setGameMode, className = 'mb-4 sm:mb-6' }) {
    const [isPickerOpen, setIsPickerOpen] = useState(false);
    // The mode whose rules are showing, or null with the sheet closed.
    const [rulesMode, setRulesMode] = useState(null);
    const logoRef = useRef(null);
    // The picker's "Full rules" that opened the sheet. The picker stays open under it.
    const rulesOpenerRef = useRef(null);

    const roomMode = getRules(room.game_mode).id;
    const canChoose = isHost && canChangeMode(room, roundScores);

    // For example through a second host device: what the picker shows would be out of date.
    useEffect(() => {
        setIsPickerOpen(false);
    }, [roomMode, canChoose]);

    const selectMode = (mode) => {
        setIsPickerOpen(false);
        if (mode !== roomMode) {
            setGameMode(mode);
        }
    };

    const showFullRules = (mode, button) => {
        rulesOpenerRef.current = button;
        setRulesMode(mode);
    };

    // A change from elsewhere can close the picker while the sheet is open.
    const rulesReturnFocusTarget = () => {
        if (rulesOpenerRef.current?.isConnected) {
            return rulesOpenerRef.current;
        }
        return logoRef.current;
    };

    const shownRules = getRules(themeMode);

    return (
        <div className={`flex flex-col items-center ${className}`}>
            <GameModePicker
                value={roomMode}
                open={isPickerOpen}
                onOpenChange={setIsPickerOpen}
                onSelect={selectMode}
                onShowRules={showFullRules}
                readOnlyReason={readOnlyReason(canChoose, isHost)}
                trigger={(
                    <GameLogoButton
                        ref={logoRef}
                        mode={themeMode}
                        action={canChoose ? 'Change mode' : 'See the modes'}
                    />
                )}
            />
            {!canChoose && (
                <p
                    role="note"
                    aria-label={`Game mode: ${shownRules.label}`}
                    className="sr-only"
                >
                    {shownRules.label}
                </p>
            )}
            <RulesDialog
                open={rulesMode !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setRulesMode(null);
                    }
                }}
                initialMode={rulesMode}
                roomMode={roomMode}
                maxScore={room.max_score}
                getReturnFocusTarget={rulesReturnFocusTarget}
            />
        </div>
    );
}
