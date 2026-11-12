import React, { useState, useRef, useEffect } from 'react';
import { Button } from "@/components/ui/button";
import { Camera, RefreshCw, Check, X, Loader2, Edit3, Image as ImageIcon } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import { useSound } from '@/components/useSound';
import { scanCards } from '@/api/ai';
import { scanWithFallback } from '@/lib/scanWithFallback';
import { useHandEntry } from '@/hooks/useHandEntry';
import { sanitizeCards } from '@/lib/scoreEntryCards';
import { getRules } from '@/lib/gameRules';
import { createRequestGuard } from '@/lib/requestGuard';
import { wrongDeckHint } from '@/lib/wrongDeckHint';
import CardListEditor from './CardListEditor';
import HandNotes from './HandNotes';
import ScoreSummary from './ScoreSummary';
import { scrollToTop } from '@/lib/scrollToTop';
import ScoreEntryPanel, { SCROLL_MARGIN_CLASS } from './ScoreEntryPanel';
import TooManyCardsAlert from './TooManyCardsAlert';

// Long edge of the photo sent for scanning. Card values must stay legible
// (300px was too small); 1024px JPEGs are typically 100-300 KB.
const SCAN_IMAGE_MAX_SIZE = 1024;
const SCAN_IMAGE_QUALITY = 0.85;

/** Shrinks a photo so its long edge is at most SCAN_IMAGE_MAX_SIZE; resolves with a JPEG data URL. */
function resizeImage(file) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const objectUrl = URL.createObjectURL(file);

        img.onload = () => {
            URL.revokeObjectURL(objectUrl);

            const scale = Math.min(1, SCAN_IMAGE_MAX_SIZE / Math.max(img.width, img.height));
            const width = Math.round(img.width * scale);
            const height = Math.round(img.height * scale);

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const dataUrl = canvas.toDataURL('image/jpeg', SCAN_IMAGE_QUALITY);

            // Mobile browsers can hold on to a detached canvas's pixel buffer for a
            // while; shrinking it releases that memory straight away.
            canvas.width = 0;
            canvas.height = 0;

            resolve(dataUrl);
        };

        // e.g. a HEIC photo on a browser that can't decode it
        img.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error('This photo format could not be opened. Try a JPEG or PNG.'));
        };

        img.src = objectUrl;
    });
}

const ModelSelector = ({ modelList, onModelChange, onModelMenuToggle, showModelMenu }) => {
    // The parent always puts the chosen model first.
    const activeModel = modelList[0];

    return (
        <div className="space-y-2">
            <div className="text-xs text-slate-600 font-medium">AI Model</div>
            <button
                onClick={onModelMenuToggle}
                className="w-full bg-slate-50 hover:bg-slate-100 rounded-lg p-3 text-left transition-colors border border-slate-200"
            >
                <p className="text-sm font-semibold text-slate-900">
                    {activeModel?.display_name}
                </p>
            </button>

            <AnimatePresence>
                {showModelMenu && (
                    <motion.div
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        className="bg-slate-50 rounded-lg border border-slate-200 overflow-hidden"
                    >
                        <div className="p-3 border-b border-slate-200 flex items-center justify-between">
                            <p className="text-sm font-semibold text-slate-900">Select Model</p>
                            <button
                                onClick={onModelMenuToggle}
                                className="text-slate-400 hover:text-slate-600 transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="max-h-[250px] overflow-y-auto divide-y divide-slate-200">
                            {modelList.map((model) => (
                                <button
                                    key={model.id}
                                    onClick={() => {
                                        onModelChange(model.id);
                                        onModelMenuToggle();
                                    }}
                                    className="w-full p-3 text-left hover:bg-slate-100 transition-colors flex items-center justify-between"
                                >
                                    <span className="text-sm text-slate-700">{model.display_name}</span>
                                    {model === activeModel && (
                                        <span className="text-xs bg-ui-accent-tint text-ui-accent-strong px-2 py-1 rounded">Active</span>
                                    )}
                                </button>
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

/** Shown instead of the capture area while the AI config loads, or when scanning is off. */
const ScanningUnavailable = ({ isLoading, onManualEntry }) => {
    if (isLoading) {
        return (
            <div className="bg-slate-50 rounded-2xl p-8 text-center min-h-[300px] flex flex-col items-center justify-center">
                <Loader2 className="w-8 h-8 animate-spin mb-2 text-ui-accent" />
                <p className="text-slate-600">Checking AI card scanning...</p>
            </div>
        );
    }

    return (
        <div
            className="flex flex-col items-center justify-center gap-4 p-8 bg-white rounded-2xl border-2 border-dashed border-slate-300 min-h-[300px] text-center"
        >
            <p className="text-lg font-bold text-slate-900">AI card scanning isn't set up on this server</p>
            <p className="text-sm text-slate-600">Enter your score manually instead.</p>
            <Button onClick={onManualEntry} className="bg-ui-accent hover:bg-ui-accent-strong">
                <Edit3 className="w-4 h-4 mr-2" />
                Enter Score Manually
            </Button>
        </div>
    );
};

/**
 * Over cards brought from manual entry when scanning is off: the cards can still be edited and
 * confirmed here, but there's no photo to take, so the player is told why.
 */
const ScanningOffNotice = ({ onManualEntry }) => (
    <div role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">AI card scanning isn&apos;t set up on this server</p>
        <p className="mt-1">You can still check your cards here, or go back to manual entry.</p>
        <Button onClick={onManualEntry} variant="outline" className="mt-3 w-full border-amber-300 bg-white text-amber-900 hover:bg-amber-100">
            <Edit3 className="w-4 h-4 mr-2" aria-hidden="true" />
            Enter Score Manually
        </Button>
    </div>
);

/** Camera capture plus a "Choose from photos" fallback (bug 7.5). */
const CaptureArea = ({ cameraInputRef, photoInputRef, onOpenPicker, onFileChosen }) => (
    <div className="space-y-3">
        <button
            type="button"
            onClick={() => onOpenPicker(cameraInputRef)}
            className="w-full flex flex-col items-center justify-center gap-4 p-16 bg-gradient-to-br from-ui-accent-soft to-ui-accent-soft-end rounded-2xl border-2 border-dashed border-ui-accent-border-strong cursor-pointer hover:border-ui-accent-bright hover:bg-ui-accent-tint transition-all min-h-[300px] focus:outline-none focus-visible:ring-2 focus-visible:ring-ui-accent-vivid"
        >
            <Camera className="w-20 h-20 text-ui-accent-bright" aria-hidden="true" />
            <span className="block text-center">
                <span className="block text-lg font-semibold text-slate-700 mb-1">Tap to capture cards</span>
                <span className="block text-sm text-slate-500">Take a photo of your cards</span>
            </span>
        </button>
        <input
            ref={cameraInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={onFileChosen}
        />

        {/* No `capture`: the browser's own picker keeps the page in front, so a low-memory
            phone is less likely to discard the tab than when handing off to the camera app. */}
        <Button
            variant="outline"
            onClick={() => onOpenPicker(photoInputRef)}
            className="w-full"
        >
            <ImageIcon className="w-4 h-4 mr-2" />
            Choose from photos
        </Button>
        <input
            ref={photoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onFileChosen}
        />
    </div>
);

/**
 * aiEnabled: null while the server config loads, then true/false.
 * modelList: [{ id, display_name }] with the chosen model first.
 * initialCards: cards restored from an interrupted entry (shown without a photo).
 * initialDuplicateAllowed: the Steal or Swap override of restored cards.
 * initialAttackPlayerId: the Flip 7 choice of restored cards.
 * attackTargets: [{ id, name }] the other players, for the Flip 7 choice.
 * onCardsChange(cards): called whenever the detected cards change, to save a draft.
 * onDuplicateAllowedChange(checked): the same, for the override.
 * onAttackChange(playerId): the same, for the Flip 7 choice.
 * isSubmitting: true while the score is being sent.
 * onScanStart(): called just before a file picker opens, while the page can still talk to the
 *   server: the camera can suspend it and kill the socket (X26).
 * gameMode: the room's mode. The score follows it live, so a switch by the host re-scores the same
 *   cards.
 * maxScore: the room's target, for the rules sheet.
 */
export default function CardScanner({
    initialCards,
    initialDuplicateAllowed = false,
    initialAttackPlayerId = null,
    attackTargets = [],
    onCardsChange,
    onDuplicateAllowedChange,
    onAttackChange,
    onCardsConfirmed,
    isSubmitting = false,
    onCancel,
    onManualEntry,
    aiEnabled,
    modelList,
    setCurrentModel,
    onScanStart,
    gameMode,
    maxScore
}) {
    const { playSuccess } = useSound();
    const [capturedImage, setCapturedImage] = useState(null);
    const [isScanning, setIsScanning] = useState(false);
    const hand = useHandEntry({
        start: {
            cards: initialCards,
            duplicateAllowed: initialDuplicateAllowed,
            attackPlayerId: initialAttackPlayerId,
        },
        gameMode,
        attackTargets,
        onCardsChange,
        onDuplicateAllowedChange,
        onAttackChange,
    });
    // Restored cards have no photo but still show the results view.
    const [hasRestoredCards, setHasRestoredCards] = useState(() => (initialCards?.length ?? 0) > 0);
    const [showModelMenu, setShowModelMenu] = useState(false);
    // What the last scan read, untouched by edits: the hint is about the photo, not the rows.
    const [scannedCards, setScannedCards] = useState([]);
    const cameraInputRef = useRef(null);
    const photoInputRef = useRef(null);
    const cardsAreaRef = useRef(null);
    // Bumped by Retake so the panel scrolls back to the capture choices.
    const [scrollRequest, setScrollRequest] = useState(0);
    // Back, retake and unmount make a running scan stale, so its result is dropped instead
    // of reaching a screen the player has left.
    const [scanGuard] = useState(createRequestGuard);

    useEffect(() => {
        return () => {
            scanGuard.invalidate();
        };
    }, [scanGuard]);

    const showResults = capturedImage !== null || hasRestoredCards;
    const { scanMode } = getRules(gameMode);
    // Read live, so the hint goes as soon as the host switches mode.
    const deckHint = wrongDeckHint(scanMode, scannedCards);
    // No cards (nothing scanned yet, or the scan failed) means no score to show; a bust has its own button.
    const hasCountedCards = hand.countedCards.length > 0;

    const showDetectedCards = (cards) => {
        hand.setCards(cards);
        playSuccess();

        setTimeout(() => {
            scrollToTop(cardsAreaRef.current);
        }, 300);
    };

    const openPicker = (inputRef) => {
        if (onScanStart) {
            onScanStart();
        }
        inputRef.current?.click();
    };

    const handleFileUpload = async (e) => {
        const file = e.target.files[0];
        // Lets the same photo be chosen again after a failed scan.
        e.target.value = '';
        if (!file) {
            return;
        }

        const isCurrent = scanGuard.begin();

        setIsScanning(true);
        try {
            const resizedImage = await resizeImage(file);
            if (!isCurrent()) {
                return;
            }
            setCapturedImage(resizedImage);

            const result = await scanWithFallback(resizedImage, modelList, { scanCards, toast, scanMode });
            if (!isCurrent()) {
                return;
            }
            // Remember a fallback model that worked so the next scan starts with it.
            setCurrentModel(result.model);
            setScannedCards(result.cards);
            // The server sends modifiers as printed ("x2", "-4"); the editor shows only digits.
            showDetectedCards(sanitizeCards(result.cards, gameMode));
        } catch (error) {
            if (!isCurrent()) {
                return;
            }
            toast.error('Failed to analyze cards', {
                description: error.message || 'Please try retaking the photo or enter manually.'
            });
        } finally {
            if (isCurrent()) {
                setIsScanning(false);
            }
        }
    };

    const goBack = () => {
        scanGuard.invalidate();
        setIsScanning(false);
        onCancel();
    };

    const retake = () => {
        scanGuard.invalidate();
        setIsScanning(false);
        setCapturedImage(null);
        setHasRestoredCards(false);
        setScannedCards([]);
        // The next photo is a new hand, and the override and Flip 7 choice were about the last one.
        hand.load();
        setScrollRequest((count) => count + 1);
    };

    const confirmButton = (
        <Button
            onClick={() => onCardsConfirmed(hand.confirmedHand)}
            disabled={isScanning || !hand.canConfirm || isSubmitting}
            className="w-full h-12 bg-emerald-600 hover:bg-emerald-700"
        >
            {isSubmitting ? (
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
                <Check className="w-4 h-4 mr-2" />
            )}
            {isSubmitting ? 'Submitting…' : 'Confirm Score'}
        </Button>
    );

    return (
        <ScoreEntryPanel
            title="Scan Cards"
            scrollRequest={scrollRequest}
            onBack={goBack}
            backDisabled={isSubmitting}
            footer={showResults ? confirmButton : null}
            gameMode={gameMode}
            maxScore={maxScore}
        >
            {!showResults && (
                <>
                    {!aiEnabled ? (
                        <ScanningUnavailable
                            isLoading={aiEnabled === null}
                            onManualEntry={onManualEntry}
                        />
                    ) : (
                        <>
                            <ModelSelector
                                modelList={modelList}
                                onModelChange={setCurrentModel}
                                onModelMenuToggle={() => setShowModelMenu(!showModelMenu)}
                                showModelMenu={showModelMenu}
                            />

                            <CaptureArea
                                cameraInputRef={cameraInputRef}
                                photoInputRef={photoInputRef}
                                onOpenPicker={openPicker}
                                onFileChosen={handleFileUpload}
                            />
                        </>
                    )}
                </>
            )}

            {showResults && (
                <>
                    {aiEnabled === false && <ScanningOffNotice onManualEntry={onManualEntry} />}

                    {isScanning && (
                        <div className="bg-slate-50 rounded-2xl p-8 text-center">
                            <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2 text-ui-accent" />
                            <p className="text-slate-600">Analyzing cards...</p>
                        </div>
                    )}

                    {/* The photo, so players can compare it with the detected cards. */}
                    {!isScanning && capturedImage && (
                        <div className="rounded-2xl overflow-hidden border border-slate-200 shadow-sm bg-slate-900">
                            <img
                                src={capturedImage}
                                alt="Captured cards"
                                className="w-full max-h-64 object-contain bg-slate-900"
                            />
                        </div>
                    )}

                    {!isScanning && hand.cards.length > 0 && (
                        <motion.div
                            ref={cardsAreaRef}
                            initial={{ opacity: 0, y: 20 }}
                            animate={{ opacity: 1, y: 0 }}
                            className={SCROLL_MARGIN_CLASS}
                        >
                            <h3 className="font-semibold text-slate-800 mb-3">Detected Cards</h3>
                            {deckHint && (
                                <p role="status" className="mb-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
                                    {deckHint}
                                </p>
                            )}
                            <CardListEditor
                                cards={hand.cards}
                                onCardsChange={hand.setCards}
                                gameMode={gameMode}
                            />

                            {hasCountedCards && (
                                <>
                                    <ScoreSummary
                                        score={hand.score}
                                        className="mb-3"
                                        attack={{ targets: attackTargets, chosenId: hand.attackPlayerId, onChoose: hand.setAttack }}
                                    />
                                    <HandNotes
                                        cards={hand.countedCards}
                                        score={hand.score}
                                        gameMode={gameMode}
                                        onCardsChange={hand.setCards}
                                        duplicateAllowed={hand.overrideOn}
                                        onDuplicateAllowedChange={hand.setOverride}
                                    />
                                </>
                            )}

                            {hand.hasTooManyCards && <TooManyCardsAlert />}
                        </motion.div>
                    )}

                    {aiEnabled !== false && (
                        <Button
                            variant="outline"
                            onClick={retake}
                            disabled={isSubmitting}
                            className="w-full"
                        >
                            <RefreshCw className="w-4 h-4 mr-2" />
                            Retake Photo
                        </Button>
                    )}
                </>
            )}
        </ScoreEntryPanel>
    );
}
