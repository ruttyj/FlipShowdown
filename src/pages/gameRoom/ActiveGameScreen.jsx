import React, { useEffect, useId, useRef, useState } from 'react';
import { SCROLL_MARGIN_CLASS } from '@/components/game/ScoreEntryPanel';
import { scrollToTop } from '@/lib/scrollToTop';
import { Button } from "@/components/ui/button";
import {
    X, ArrowRight, CheckCircle, Trophy, Edit3, ScanLine, Keyboard, Loader2, Hourglass, RotateCcw
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import CardScanner from '@/components/game/CardScanner';
import Scoreboard from '@/components/game/Scoreboard';
import ManualScoreEntry from '@/components/game/ManualScoreEntry';
import ScoreEditor from '@/components/game/ScoreEditor';
import ChatButton from '@/components/game/ChatButton';
import ChatDialog from '@/components/game/ChatDialog';
import QuickSendBar from '@/components/game/QuickSendBar';
import EmojiAnimation from '@/components/game/EmojiAnimation';
import { enteringMessage, isNextDealerHighlighted } from '@/lib/entryStatus';
import { calculateFlip7Score } from '@/lib/flip7Scoring';
import { keepAtTop } from '@/lib/keepInClearView';
import { floatingStacksClearance } from '@/lib/floatingStacks';
import { getRules } from '@/lib/gameRules';
import { displayScore, findStoredScore, spokenScore } from '@/lib/roundScores';
import { reachedServer } from '@/lib/scoreLifecycle';
import ActivePlayersPanel from './ActivePlayersPanel';
import RoomHeader, { RulesFooter } from './RoomHeader';

const PANEL_MOTION = {
    initial: { opacity: 0, y: 20 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -20 },
};

/**
 * Advisory: asks the table to wait, and blocks nothing (X40). The live region stays mounted while
 * empty, because screen readers only announce a change inside a region they already know about.
 */
function EnteringNotice({ message }) {
    return (
        <div aria-live="polite">
            {message && (
                <p className="mb-3 flex items-center gap-2 rounded-full border border-amber-300 bg-amber-100 px-4 py-2 text-sm font-semibold text-amber-900 animate-pulse motion-reduce:animate-none">
                    <Hourglass className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span>{message}</span>
                </p>
            )}
        </div>
    );
}

/**
 * One half of the turn card. The slot the table should look at is raised on a white card; the other
 * is dimmed. `pulses` marks the next dealer once a round is under way (X48).
 */
function TurnSlot({ label, name, isFocus, pulses = false }) {
    const labelId = useId();

    let slotStyle = 'opacity-50';
    let nameStyle = 'text-lg font-bold text-slate-700';
    if (isFocus) {
        slotStyle = 'bg-white/90 shadow-md ring-1 ring-ui-accent-border';
        nameStyle = 'text-xl sm:text-2xl font-black text-ui-accent-strong';
    }
    if (pulses) {
        nameStyle += ' animate-pulse motion-reduce:animate-none';
    }

    return (
        <div
            role="group"
            aria-labelledby={labelId}
            className={`min-w-0 rounded-xl px-3 py-3 sm:px-4 transition-all duration-300 motion-reduce:transition-none ${slotStyle}`}
        >
            <p id={labelId} className="text-[11px] font-semibold uppercase tracking-wider text-ui-accent">{label}</p>
            <p className={`mt-1 break-words leading-tight ${nameStyle}`}>{name}</p>
        </div>
    );
}

/**
 * `players` are sorted by turn order. `enteringPlayers` are the others entering cards now. The
 * current dealer and the next one sit side by side. `highlightsNextDealer` moves the focus from the
 * current dealer, who dims, to the next one, who pulses (X48). The focus also moves the white card,
 * so the change still shows under `prefers-reduced-motion`.
 */
function TurnIndicator({ players, currentTurnPlayerId, enteringPlayers, highlightsNextDealer }) {
    const currentTurnIndex = players.findIndex(p => p.id === currentTurnPlayerId);
    if (currentTurnIndex === -1) {
        return null;
    }

    const currentTurnPlayer = players[currentTurnIndex];
    const nextTurnPlayer = players[(currentTurnIndex + 1) % players.length];

    return (
        <div className="mb-4 bg-gradient-to-r from-ui-accent-soft to-ui-accent-soft-end rounded-2xl p-3 sm:p-4 border-2 border-ui-accent-border">
            <EnteringNotice message={enteringMessage(enteringPlayers)} />
            <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
                <TurnSlot label="Current Turn" name={currentTurnPlayer.name} isFocus={!highlightsNextDealer} />
                <ArrowRight className="w-5 h-5 text-ui-accent" aria-hidden="true" />
                <TurnSlot
                    label="Next Up"
                    name={nextTurnPlayer.name}
                    isFocus={highlightsNextDealer}
                    pulses={highlightsNextDealer}
                />
            </div>
        </div>
    );
}

function WaitingForPlayers({ players }) {
    const waitingPlayers = players.filter(p => !p.has_submitted_round);
    if (waitingPlayers.length === 0) {
        return null;
    }

    let names = waitingPlayers.slice(0, 2).map(p => p.name).join(', ');
    if (waitingPlayers.length > 2) {
        names += '...';
    }
    let playerWord = 'players';
    if (waitingPlayers.length === 1) {
        playerWord = 'player';
    }

    return (
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <p className="text-sm text-slate-700 text-center mb-2">
                Waiting for {waitingPlayers.length} {playerWord}
            </p>
            <p className="text-xs text-slate-600 text-center">{names}</p>
        </div>
    );
}

/**
 * The minus cards still reaching a busted player (§3.14), as one tap each: the cards in front of them
 * are out of play, so nothing here needs typing and no keyboard opens. While one is on its way the
 * buttons are aria-disabled, not disabled, because a disabled button drops the focus it holds.
 *
 * @param {object} props
 * @param {string[]} props.values  the card values to offer
 * @param {(value: string) => void} props.onAdd
 * @param {boolean} props.isAdding  one is on its way, and the next has to build on it
 */
function AddMinusCardRow({ values, onAdd, isAdding }) {
    const addUnlessBusy = (value) => {
        if (!isAdding) {
            onAdd(value);
        }
    };

    return (
        <div role="group" aria-label="Add a minus card" className="mt-3">
            <p className="mb-1 text-sm font-medium text-slate-800">Add a minus card</p>
            <div className="flex gap-1.5">
                {values.map((value) => (
                    <Button
                        key={value}
                        onClick={() => addUnlessBusy(value)}
                        aria-disabled={isAdding}
                        variant="outline"
                        aria-label={`Add −${value}`}
                        className="h-11 min-w-0 flex-1 border-red-300 bg-white px-1 font-semibold text-red-800 hover:bg-red-100 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                    >
                        −{value}
                    </Button>
                ))}
            </div>
        </div>
    );
}

/** A hand's minus cards: a duplicate bust keeps its number cards too, and those score nothing. */
function minusCardValues(cards = []) {
    return cards.filter((card) => card.type === 'subtractor').map((card) => card.value);
}

/**
 * The score so far, in a live region so each card's new total is announced. A screen reader gets its
 * own wording, which says "minus" rather than leaving it to how the sign is read.
 */
function ScoreSoFar({ score }) {
    return (
        <p aria-live="polite" aria-atomic="true" className="text-sm font-semibold text-red-900">
            <span aria-hidden="true">Score so far: {displayScore(score)}</span>
            <span className="sr-only">Your score so far is {spokenScore(score)}</span>
        </p>
    );
}

const APPLIED_CARD_CLASS = 'inline-flex h-9 items-center gap-1 rounded-md bg-red-700 px-2.5 text-sm font-semibold text-white';

/**
 * The minus cards already counting against a busted player, with the score they come to. They are
 * solid where the buttons that add them are outlined, so the two can't be mistaken for each other.
 *
 * @param {object} props
 * @param {string[]} props.values
 * @param {number} props.score
 * @param {(index: number) => void} [props.onRemove]  makes each card a button that takes it off
 */
function AppliedMinusCards({ values, score, onRemove }) {
    const titleId = useId();

    return (
        <section aria-labelledby={titleId} className="mt-3 rounded-lg border border-red-200 bg-white p-3 text-left">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <h4 id={titleId} className="text-sm font-medium text-slate-800">Applied to you</h4>
                <ScoreSoFar score={score} />
            </div>
            {values.length === 0 ? (
                <p className="mt-1 text-sm text-slate-600">None yet</p>
            ) : (
                <ul className="mt-2 flex flex-wrap gap-1.5">
                    {values.map((value, index) => (
                        <li key={index}>
                            {onRemove ? (
                                <button
                                    type="button"
                                    onClick={() => onRemove(index)}
                                    aria-label={`Remove −${value}`}
                                    className={`${APPLIED_CARD_CLASS} hover:bg-red-800`}
                                >
                                    −{value}
                                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            ) : (
                                <span className={APPLIED_CARD_CLASS}>−{value}</span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

/** A bust that can still take minus cards (X43), which its panel offers. */
function takesLateMinusCards(storedScore, rules) {
    return storedScore?.busted === true && rules.modifiersAfterBust;
}

/**
 * What I entered this round, with the one way to fix it until the round closes (X45). In a mode where
 * modifiers can reach a bust, a bust also shows its score so far and takes more minus cards (X43).
 * `storedScore` can lag my submitted flag by a moment, and until it arrives there's nothing to take back.
 * Undo waits for a card on its way: taking the score back before that card lands would lose it.
 */
function SubmittedPanel({ storedScore, takeBackScore, isTakingBack, rules, addMinusCard, isAddingMinusCard }) {
    const isBust = storedScore?.busted === true;
    const takesMinusCards = takesLateMinusCards(storedScore, rules);
    const reminder = rules.submittedReminder;
    const hasCardsToFix = takesMinusCards && storedScore.cards?.length > 0;
    const panelRef = useRef(null);

    // The minus cards sit low on the screen, where the floating quick sends and toggles would cover
    // their edges and take the tap, and the wrong tap sends a message. So bring them above the stacks.
    useEffect(() => {
        if (takesMinusCards) {
            scrollToTop(panelRef.current);
        }
    }, [takesMinusCards]);

    let message = 'Score submitted!';
    let actionLabel = null;
    if (isBust) {
        message = 'You busted this round';
        actionLabel = 'Undo bust';
    } else if (storedScore) {
        message = `Score submitted: ${storedScore.final_score}`;
        actionLabel = 'Change score';
    }

    return (
        <div ref={panelRef} className={`rounded-xl p-4 text-center border ${SCROLL_MARGIN_CLASS} ${isBust ? 'bg-red-50 border-red-200' : 'bg-emerald-50 border-emerald-200'}`}>
            {isBust ? (
                <X className="w-8 h-8 text-red-600 mx-auto mb-2" aria-hidden="true" />
            ) : (
                <CheckCircle className="w-8 h-8 text-emerald-600 mx-auto mb-2" aria-hidden="true" />
            )}
            <p className={`font-medium ${isBust ? 'text-red-900' : 'text-emerald-900'}`}>{message}</p>
            {reminder && <p className="mt-1 text-xs text-slate-600">{reminder}</p>}
            {takesMinusCards && (
                <>
                    <AddMinusCardRow values={rules.lateMinusCards} onAdd={addMinusCard} isAdding={isAddingMinusCard} />
                    <AppliedMinusCards values={minusCardValues(storedScore.cards)} score={storedScore.final_score} />
                </>
            )}
            {hasCardsToFix && (
                <p className="mt-2 text-xs text-slate-700">Wrong card? Undo bust opens your cards to fix them.</p>
            )}
            {actionLabel && (
                <Button
                    onClick={takeBackScore}
                    disabled={isTakingBack || isAddingMinusCard}
                    variant="outline"
                    className="mt-3 h-11 sm:h-auto border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
                >
                    <RotateCcw className="w-4 h-4 mr-2" aria-hidden="true" />
                    {actionLabel}
                </Button>
            )}
        </div>
    );
}

/**
 * The Bust tile's step where modifiers can reach a bust (X43): the minus cards already on the player go
 * in before the bust is sent, because the last player's bust closes the round and leaves no panel to
 * add them on. It doubles as the bust's confirmation.
 *
 * @param {object} props
 * @param {object} props.rules
 * @param {(minusValues: string[]) => void} props.onConfirm
 * @param {() => void} props.onCancel
 * @param {boolean} props.isSubmitting
 */
function BustMinusCardsStep({ rules, onConfirm, onCancel, isSubmitting }) {
    const [minusValues, setMinusValues] = useState([]);
    const panelRef = useRef(null);
    const score = calculateFlip7Score(minusValues.map((value) => ({ type: 'subtractor', value })), rules.id, { busted: true });

    // Focus so it isn't lost with the tile, and clear of the floating stacks like the bust panel.
    useEffect(() => {
        panelRef.current.focus({ preventScroll: true });
        scrollToTop(panelRef.current);
    }, []);

    const removeCard = (index) => {
        setMinusValues(minusValues.filter((_, position) => position !== index));
    };

    return (
        <div ref={panelRef} tabIndex={-1} className={`rounded-xl p-4 text-center border bg-red-50 border-red-200 outline-none ${SCROLL_MARGIN_CLASS}`}>
            <h3 className="font-medium text-red-900">Mark as bust</h3>
            <p className="mt-1 text-xs text-slate-700">{rules.bustWarning}</p>
            <AddMinusCardRow values={rules.lateMinusCards} onAdd={(value) => setMinusValues([...minusValues, value])} isAdding={false} />
            <AppliedMinusCards values={minusValues} score={score.finalScore} onRemove={removeCard} />
            <div className="mt-3 flex gap-2">
                <Button
                    onClick={onCancel}
                    disabled={isSubmitting}
                    variant="outline"
                    className="h-11 flex-1 border-slate-300 bg-white text-slate-800 hover:bg-slate-100"
                >
                    Cancel
                </Button>
                <Button
                    onClick={() => onConfirm(minusValues)}
                    disabled={isSubmitting}
                    className="h-11 flex-1 bg-red-700 text-white hover:bg-red-800"
                >
                    {isSubmitting ? 'Submitting…' : 'Confirm Bust'}
                </Button>
            </div>
        </div>
    );
}

/**
 * Bust / manual / scan buttons before I've submitted, the submitted panel after. The minus card step
 * remembers its round, so a round moving on or a switch to a mode without it puts the tiles back.
 * `isScanningOff` fades the Scan tile when the server has no AI scanning set up.
 */
function MyRoundActions({ currentPlayer, players, bust, openScoreEntry, isSubmitting, storedScore, takeBackScore, isTakingBack, rules, addMinusCard, isAddingMinusCard, currentRound, isScanningOff }) {
    const [bustStepRound, setBustStepRound] = useState(null);

    const confirmBust = async (minusValues) => {
        const outcome = await bust(minusValues);
        if (reachedServer(outcome)) {
            setBustStepRound(null);
        }
    };

    const startBust = () => {
        if (rules.modifiersAfterBust) {
            setBustStepRound(currentRound);
        } else {
            bust();
        }
    };

    if (currentPlayer?.has_submitted_round) {
        return (
            <>
                <SubmittedPanel
                    storedScore={storedScore}
                    takeBackScore={takeBackScore}
                    isTakingBack={isTakingBack}
                    rules={rules}
                    addMinusCard={addMinusCard}
                    isAddingMinusCard={isAddingMinusCard}
                />
                <WaitingForPlayers players={players} />
            </>
        );
    }

    if (rules.modifiersAfterBust && bustStepRound === currentRound) {
        return (
            <BustMinusCardsStep
                rules={rules}
                onConfirm={confirmBust}
                onCancel={() => setBustStepRound(null)}
                isSubmitting={isSubmitting}
            />
        );
    }

    // The three tiles share the row equally and stack icon over label so they fit one row at
    // 360px without wrapping.
    return (
        <div className="flex gap-2 sm:gap-3">
            <BustTile bust={startBust} isSubmitting={isSubmitting} />
            <EntryTile
                onClick={() => openScoreEntry('manual')}
                disabled={isSubmitting}
                icon={Keyboard}
                label="Enter Score Manually"
                wideLabel="Enter Score"
                shortLabel="Manual"
                className="from-tile-manual-start to-tile-manual-end shadow-tile-manual-shadow hover:from-tile-manual-hover hover:to-tile-manual-end"
            />
            <EntryTile
                onClick={() => openScoreEntry('scanner')}
                disabled={isSubmitting}
                icon={ScanLine}
                label={isScanningOff ? 'Scan Cards (not set up on this server)' : 'Scan Cards'}
                wideLabel="Scan Cards"
                shortLabel="Scan"
                note={isScanningOff ? 'Not set up' : null}
                className="from-tile-scan-start to-tile-scan-end shadow-tile-scan-shadow hover:from-tile-scan-hover-start hover:to-tile-scan-hover-end"
            />
        </div>
    );
}

const TILE_BASE = 'h-20 sm:h-24 flex-col gap-1.5 rounded-xl font-semibold transition-all '
    + 'active:scale-[0.97] active:shadow-sm [&_svg]:size-6 sm:[&_svg]:size-7';

/**
 * A primary score-entry button. `label` is its accessible name; the visible text is `wideLabel`
 * on wider screens and `shortLabel` on phones, where the tile is only ~100px wide. A `note` fades
 * the tile and says why under the label, while it stays tappable to explain more.
 */
function EntryTile({ onClick, disabled, icon: Icon, label, wideLabel, shortLabel, note = null, className }) {
    let fadedStyle = '';
    if (note) {
        fadedStyle = 'opacity-50 saturate-50';
    }

    return (
        <Button
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={`${TILE_BASE} flex-1 min-w-0 bg-gradient-to-br text-white text-sm sm:text-base shadow-lg ring-1 ring-inset ring-white/20 ${className} ${fadedStyle}`}
        >
            <Icon aria-hidden="true" />
            <span className="sm:hidden">{shortLabel}</span>
            <span className="hidden sm:inline">{wideLabel}</span>
            {note && <span className="-mt-1 text-[10px] sm:text-xs font-medium leading-none">{note}</span>}
        </Button>
    );
}

function BustTile({ bust, isSubmitting }) {
    // The bust submits straight away, so it doubles as the "submitting" indicator.
    let accessibleName = 'Bust';
    if (isSubmitting) {
        accessibleName = 'Submitting…';
    }

    return (
        <Button
            onClick={bust}
            disabled={isSubmitting}
            aria-label={accessibleName}
            className={`${TILE_BASE} flex-1 min-w-0 bg-gradient-to-br from-red-600 to-red-800 text-white text-sm sm:text-base shadow-lg shadow-red-700/30 ring-1 ring-inset ring-white/20 hover:from-red-500 hover:to-red-700`}
        >
            {isSubmitting ? <Loader2 className="animate-spin" aria-hidden="true" /> : <X aria-hidden="true" />}
            <span>Bust</span>
        </Button>
    );
}

function HostRoundActions({ allPlayersSubmitted, host, busy }) {
    return (
        <>
            {!allPlayersSubmitted && (
                <Button
                    onClick={host.forceNextRound}
                    disabled={busy.forceNextRound === true}
                    variant="outline"
                    className="w-full h-11 sm:h-auto border-slate-200 text-slate-700 hover:bg-slate-100 text-sm sm:text-base"
                >
                    <ArrowRight className="w-4 sm:w-5 h-4 sm:h-5 mr-1 sm:mr-2" />
                    Force Next Round
                </Button>
            )}

            <div className="pt-3 sm:pt-4 border-t border-slate-200 space-y-2 sm:space-y-3">
                <Button
                    onClick={() => host.setEditMode(true)}
                    disabled={busy.setEditMode === true}
                    variant="outline"
                    className="w-full h-11 sm:h-auto border-slate-200 text-slate-700 hover:bg-slate-100 text-sm sm:text-base"
                >
                    <Edit3 className="w-4 sm:w-5 h-4 sm:h-5 mr-1 sm:mr-2" />
                    Edit Scores
                </Button>
                <Button
                    onClick={host.endGame}
                    disabled={busy.endGame === true}
                    variant="outline"
                    className="w-full h-11 sm:h-auto border-slate-200 text-slate-700 hover:bg-slate-100 text-sm sm:text-base"
                >
                    <Trophy className="w-4 sm:w-5 h-4 sm:h-5 mr-1 sm:mr-2" />
                    End Game Now
                </Button>
            </div>
        </>
    );
}

/**
 * Which panel shows under the scoreboard. In order: players wait while the host edits scores
 * (edit mode lives on the room, bug 3.6), the host's score editor, an open score entry, or
 * the round's action buttons.
 */
function choosePanel({ isEditMode, isHost }, { showScanner, showManualEntry }) {
    if (isEditMode && !isHost) {
        return 'editing-notification';
    }
    if (isEditMode) {
        return 'editor';
    }
    if (showScanner) {
        return 'scanner';
    }
    if (showManualEntry) {
        return 'manual';
    }
    return 'actions';
}

/**
 * @param {object} props
 * @param {string} props.panel  from choosePanel
 * @param {object} props.game  useGameRoom's result
 * @param {() => void} props.onEntryBack  called after Back on the scanner or manual entry closes it
 */
function RoundPanel({ panel, game, onEntryBack }) {
    const { table, scoreEntry, scanModels, host } = game;
    const { room, players, roundScores, currentPlayer, isHost, busy } = table;
    const isSubmitting = busy.submitScore === true;
    const allPlayersSubmitted = players.every(p => p.has_submitted_round);
    const attackTargets = players.filter(p => p.id !== currentPlayer?.id);
    const backFromEntry = () => {
        scoreEntry.closeScoreEntry();
        onEntryBack();
    };

    if (panel === 'editing-notification') {
        return (
            <motion.div
                {...PANEL_MOTION}
                className="bg-slate-50 border border-slate-200 rounded-xl p-6 text-center"
            >
                <p className="text-slate-900 font-medium mb-1">Host is editing scores</p>
                <p className="text-slate-700 text-sm">Please wait...</p>
            </motion.div>
        );
    }

    if (panel === 'editor') {
        return (
            <motion.div {...PANEL_MOTION}>
                {/* The editor reads its start on mount, so a new start needs a new editor. */}
                <ScoreEditor
                    key={scoreEntry.editorStart ? `${scoreEntry.editorStart.player_id}:${scoreEntry.editorStart.round_number}` : 'grid'}
                    players={players}
                    roundScores={roundScores}
                    room={room}
                    initialEdit={scoreEntry.editorStart}
                    onSaveScore={host.editScore}
                    isSaving={busy.editScore === true}
                    onClose={() => host.setEditMode(false)}
                    isClosing={busy.setEditMode === true}
                />
            </motion.div>
        );
    }

    if (panel === 'scanner') {
        return (
            <motion.div {...PANEL_MOTION}>
                <CardScanner
                    initialCards={scoreEntry.pendingCards}
                    initialDuplicateAllowed={scoreEntry.pendingDuplicateAllowed}
                    initialAttackPlayerId={scoreEntry.pendingAttackPlayerId}
                    attackTargets={attackTargets}
                    onCardsChange={scoreEntry.savePendingDraft}
                    onDuplicateAllowedChange={scoreEntry.savePendingDuplicateAllowed}
                    onAttackChange={scoreEntry.savePendingAttack}
                    onCardsConfirmed={scoreEntry.submitScore}
                    isSubmitting={isSubmitting}
                    onCancel={backFromEntry}
                    onManualEntry={scoreEntry.switchToManualEntry}
                    aiEnabled={scanModels.enabled}
                    modelList={scanModels.models}
                    setCurrentModel={scanModels.rememberModel}
                    onScanStart={scoreEntry.startScanning}
                    gameMode={room.game_mode}
                    maxScore={room.max_score}
                />
            </motion.div>
        );
    }

    if (panel === 'manual') {
        return (
            <motion.div {...PANEL_MOTION}>
                <ManualScoreEntry
                    initialCards={scoreEntry.pendingCards}
                    initialDuplicateAllowed={scoreEntry.pendingDuplicateAllowed}
                    initialAttackPlayerId={scoreEntry.pendingAttackPlayerId}
                    attackTargets={attackTargets}
                    onCardsChange={scoreEntry.savePendingDraft}
                    onDuplicateAllowedChange={scoreEntry.savePendingDuplicateAllowed}
                    onAttackChange={scoreEntry.savePendingAttack}
                    onScoreConfirmed={scoreEntry.submitScore}
                    isSubmitting={isSubmitting}
                    onCancel={backFromEntry}
                    gameMode={room.game_mode}
                    maxScore={room.max_score}
                />
            </motion.div>
        );
    }

    return (
        <motion.div {...PANEL_MOTION} className="space-y-4">
            <MyRoundActions
                currentPlayer={currentPlayer}
                players={players}
                bust={scoreEntry.bust}
                openScoreEntry={scoreEntry.openScoreEntry}
                isSubmitting={isSubmitting}
                storedScore={findStoredScore(roundScores, currentPlayer?.id, room.current_round)}
                takeBackScore={scoreEntry.takeBackScore}
                isTakingBack={busy.retractScore === true}
                rules={getRules(room.game_mode)}
                addMinusCard={scoreEntry.addMinusCard}
                isAddingMinusCard={busy.addMinusCard === true}
                currentRound={room.current_round}
                isScanningOff={scanModels.enabled === false}
            />
            {isHost && (
                <HostRoundActions
                    allPlayersSubmitted={allPlayersSubmitted}
                    host={host}
                    busy={busy}
                />
            )}
        </motion.div>
    );
}

/** @param {{game: object}} props  game is useGameRoom's result */
export default function ActiveGameScreen({ game }) {
    const { table, scoreEntry, host, chat, theme, leave } = game;
    const { room, players, roundScores, currentPlayer, isHost, busy } = table;
    const { enteringPlayers, enteredScoreRound } = scoreEntry;
    const panel = choosePanel(table, scoreEntry);
    const gameCardRef = useRef(null);
    const [turnCardReturns, setTurnCardReturns] = useState(0);
    const showsChat = room.status === 'playing' && Boolean(currentPlayer);
    // Matches the condition that renders QuickSendBar below. Muting hides the buttons (X44), and
    // the quick sends only take room while unfolded from the chat button (X79).
    const showsChatButtons = showsChat && !chat.isMuted;
    const shownQuickSendCount = showsChatButtons && chat.quickSendsOpen ? chat.quickSends.length : 0;
    const scoreboardRef = useRef(null);
    const [scoreboardReturns, setScoreboardReturns] = useState(0);

    // Back from an entry screen returns to the scoreboard's top, however far down the entry screen
    // was scrolled (X76). It waits for the render that closes the entry, because the turn card above
    // the scoreboard changes height in it. keepAtTop because the manual screen's keyboard closing
    // interrupts a smooth scroll, as its opening does (X56).
    useEffect(() => {
        if (scoreboardReturns > 0) {
            return keepAtTop(scoreboardRef.current);
        }
    }, [scoreboardReturns]);

    const returnToScoreboard = () => {
        setScoreboardReturns((count) => count + 1);
    };

    // A score or bust I just sent brings the game card's top, the turn card, to the top of the
    // screen, so the next turn starting is seen (X47). Also when it closed the round. A bust that
    // takes minus cards keeps its own panel there instead: under the turn card, a short phone's
    // floating buttons cover Add −2 (X43). Used up here, so the screen doesn't move again later in
    // the round. Counted, like the scoreboard returns, because using it up re-renders and would
    // otherwise stop keepAtTop following the keyboard.
    const myStoredScore = findStoredScore(roundScores, currentPlayer?.id, room.current_round);
    const bustPanelKeepsTop = takesLateMinusCards(myStoredScore, getRules(room.game_mode));
    useEffect(() => {
        if (enteredScoreRound === null) {
            return;
        }
        if (!bustPanelKeepsTop) {
            setTurnCardReturns((count) => count + 1);
        }
        scoreEntry.clearEnteredScoreRound();
    }, [enteredScoreRound]);

    useEffect(() => {
        if (turnCardReturns > 0) {
            return keepAtTop(gameCardRef.current);
        }
    }, [turnCardReturns]);

    // The clearance eases as the quick sends fold and unfold, so the page doesn't jump near its end.
    return (
        <div
            className="min-h-screen game-screen-bg p-6 py-8 transition-[padding-bottom] duration-200 ease-out motion-reduce:transition-none"
            style={floatingStacksClearance(shownQuickSendCount)}
        >
            <div className="max-w-lg mx-auto">
                <RoomHeader
                    room={room}
                    themeMode={theme.mode}
                    isHost={isHost}
                    roundScores={roundScores}
                    setGameMode={host.setGameMode}
                    className="mb-6"
                />

                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    ref={gameCardRef}
                    data-game-card
                    className={`bg-white rounded-2xl sm:rounded-3xl p-3 sm:p-8 ${SCROLL_MARGIN_CLASS}`}
                >
                    <TurnIndicator
                        players={players}
                        currentTurnPlayerId={room.current_turn_player_id}
                        enteringPlayers={enteringPlayers}
                        highlightsNextDealer={isNextDealerHighlighted({
                            room,
                            players,
                            enteringPlayers,
                            hasEntryOpen: scoreEntry.isOpen,
                        })}
                    />

                    <div ref={scoreboardRef} data-scoreboard className={SCROLL_MARGIN_CLASS}>
                        <Scoreboard
                            players={players}
                            currentRound={room.current_round}
                            roundScores={roundScores}
                            currentPlayerId={currentPlayer?.id}
                        />
                    </div>

                    <div className="mt-6">
                        <AnimatePresence mode="wait">
                            {/* Keyed by panel so AnimatePresence plays the exit animation on a switch. */}
                            <RoundPanel key={panel} panel={panel} game={game} onEntryBack={returnToScoreboard} />
                        </AnimatePresence>
                    </div>

                    <ActivePlayersPanel
                        roomId={room.id}
                        players={players}
                        currentPlayer={currentPlayer}
                        isHost={isHost}
                        kick={host.kick}
                        leave={leave}
                        busy={busy}
                    />
                </motion.div>

                <RulesFooter room={room} />
            </div>

            {/* initial={false}: they only slide in when unmuting, not whenever the screen opens. */}
            <AnimatePresence initial={false}>
                {showsChatButtons && (
                    <QuickSendBar
                        key="quick-sends"
                        chat={chat}
                        isExpanded={chat.quickSendsOpen}
                        onSend={chat.closeQuickSends}
                    />
                )}
                {showsChatButtons && (
                    <ChatButton
                        key="chat-button"
                        onTap={chat.tapChatButton}
                        onDoubleTap={chat.doubleTapChatButton}
                        isOpen={chat.isOpen}
                        isExpanded={chat.quickSendsOpen}
                    />
                )}
            </AnimatePresence>

            {showsChat && <ChatDialog chat={chat} />}

            {/* Renders independently of the chat, so received messages show even while it's closed */}
            {chat.playing && (
                <EmojiAnimation
                    item={chat.playing}
                    onClose={chat.dismissPlaying}
                />
            )}
        </div>
    );
}
