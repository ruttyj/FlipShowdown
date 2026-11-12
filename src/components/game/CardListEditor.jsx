import React, { useEffect, useRef, useState } from 'react';
import { Button } from "@/components/ui/button";
import { X, Plus, Divide, Minus, Hash } from 'lucide-react';
import { specialCardLabel } from '@/lib/gameRules';
import { keepInClearView } from '@/lib/keepInClearView';
import {
    addCard,
    addNextCard,
    cardsPastSeven,
    cardTypeOption,
    cardTypeOptions,
    isTypeOptionTaken,
    retypeCard,
    sanitizeCard,
    sanitizeCards,
    sanitizeTypedCard,
    switchCardType,
} from '@/lib/scoreEntryCards';

// A card type's colours, shared by its row and its switch button so a type always looks the same.
// Written out in full so Tailwind finds the classes.
const TYPE_STYLES = {
    number: {
        picker: 'border-blue-300 bg-blue-50 text-blue-700',
        input: 'border-blue-300 focus:border-blue-700',
        idleButton: 'border-blue-300 bg-white text-blue-700 hover:bg-blue-50',
        activeButton: 'border-blue-700 bg-blue-700 text-white',
    },
    multiplier: {
        picker: 'border-purple-300 bg-purple-50 text-purple-700',
        input: 'border-purple-300 focus:border-purple-700',
        idleButton: 'border-purple-300 bg-white text-purple-700 hover:bg-purple-50',
        activeButton: 'border-purple-700 bg-purple-700 text-white',
    },
    divisor: {
        picker: 'border-amber-300 bg-amber-50 text-amber-700',
        input: 'border-amber-300 focus:border-amber-700',
        idleButton: 'border-amber-300 bg-white text-amber-700 hover:bg-amber-50',
        activeButton: 'border-amber-700 bg-amber-700 text-white',
    },
    adder: {
        picker: 'border-green-300 bg-green-50 text-green-700',
        input: 'border-green-300 focus:border-green-700',
        idleButton: 'border-green-300 bg-white text-green-700 hover:bg-green-50',
        activeButton: 'border-green-700 bg-green-700 text-white',
    },
    subtractor: {
        picker: 'border-red-300 bg-red-50 text-red-700',
        input: 'border-red-300 focus:border-red-700',
        idleButton: 'border-red-300 bg-white text-red-700 hover:bg-red-50',
        activeButton: 'border-red-700 bg-red-700 text-white',
    },
    special: {
        picker: 'border-rose-400 bg-rose-100 text-rose-900',
        idleButton: 'border-rose-400 bg-white text-rose-800 hover:bg-rose-50',
        activeButton: 'border-rose-800 bg-rose-800 text-white',
    },
};

// The name and icon of each type's switch button. Special cards have neither: their name is the option's.
const TYPE_BUTTONS = {
    number: { label: 'Number', Icon: Hash },
    multiplier: { label: 'Multiply', Icon: X },
    divisor: { label: 'Divide', Icon: Divide },
    adder: { label: 'Plus', Icon: Plus },
    subtractor: { label: 'Minus', Icon: Minus },
};

// A second tap on Add card this soon, with nothing typed since, is a double tap and not another card.
const DOUBLE_TAP_MS = 300;

/** A card type's colours. A type from outside the list looks like an adder, which it scores as. */
function typeStyle(type) {
    return TYPE_STYLES[type] || TYPE_STYLES.adder;
}

/**
 * The buttons that switch the active row's type. A special button is disabled once that card is in
 * the hand, as a deck has only one; the picker still works for the rare game with two decks.
 *
 * @param {object} props
 * @param {{type: string, value: string}[]} props.cards  never empty
 * @param {number} props.activeIndex  the row they act on
 * @param {string} [props.gameMode]
 * @param {(option: string) => void} props.onSwitch  receives a value from cardTypeOptions
 */
function CardTypeSwitcher({ cards, activeIndex, gameMode, onSwitch }) {
    const activeCard = cards[activeIndex];
    const currentOption = cardTypeOption(activeCard);
    const options = cardTypeOptions(gameMode, activeCard);
    const caption = `Switch card ${activeIndex + 1} to`;

    return (
        <div role="group" aria-label={caption} className="mb-3">
            <p className="text-xs font-medium text-slate-500 mb-1.5">{caption}</p>
            <div className="grid grid-cols-3 gap-1.5">
                {options.map((option) => {
                    const button = TYPE_BUTTONS[option.value];
                    const style = typeStyle(button ? option.value : 'special');
                    const isCurrent = option.value === currentOption;
                    const Icon = button?.Icon;

                    return (
                        <button
                            key={option.value}
                            type="button"
                            aria-pressed={isCurrent}
                            disabled={!isCurrent && isTypeOptionTaken(cards, option.value)}
                            onClick={() => onSwitch(option.value)}
                            className={`flex flex-col items-center justify-center gap-0.5 min-h-12 px-0.5 rounded-lg border-2 text-[11px] sm:text-xs font-semibold leading-tight transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-ui-accent-vivid disabled:opacity-40 disabled:pointer-events-none ${
                                isCurrent ? style.activeButton : style.idleButton
                            }`}
                        >
                            {Icon && <Icon className="w-4 h-4" strokeWidth={2.5} aria-hidden="true" />}
                            {button ? button.label : option.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/**
 * @param {object} props
 * @param {{type: string, value: string}[]} props.cards  modifier values already without signs
 *        (see sanitizeCards)
 * @param {(cards: {type: string, value: string}[]) => void} props.onCardsChange
 * @param {boolean} [props.autoFocusOnMount]  focus the last value field on open, for a screen
 *        that is about to be typed in. Fixed for the editor's lifetime.
 * @param {string} [props.gameMode]  the room's mode, which decides what can be added. Rows already
 *        here stay whatever the mode, so a restored draft never loses a card.
 */
export default function CardListEditor({ cards, onCardsChange, autoFocusOnMount = false, gameMode }) {
    const activeInputRef = useRef(null);
    const addButtonRef = useRef(null);
    const lastAddTimeRef = useRef(null);
    // Bumped by every request, so focus also moves when the number of cards stays the same.
    const [focusRequests, setFocusRequests] = useState(0);
    // The row last focused, which a tap on a type button doesn't clear (iOS doesn't focus a tapped
    // button, other browsers do). Null follows the newest row.
    const [chosenIndex, setChosenIndex] = useState(null);
    const lastIndex = cards.length - 1;
    const activeIndex = chosenIndex === null ? lastIndex : Math.min(chosenIndex, lastIndex);
    const pastSeven = cardsPastSeven(cards);

    // Focus raises the phone keyboard, which hides the card list. So only a row waiting for its value
    // moves it, never opening the editor, removing a card or new cards arriving from a scan or draft
    // (X39). Testing focusRequests rather than skipping the first run also holds under StrictMode,
    // which runs effects twice on mount.
    useEffect(() => {
        if (focusRequests === 0) {
            return undefined;
        }

        if (activeIndex !== lastIndex) {
            activeInputRef.current?.focus();
            return undefined;
        }
        // The new row pushes Add card down, and the keyboard may be about to cover it too. That scroll
        // waits for the row to show (X57), so the browser's own scroll to the field mustn't beat it.
        activeInputRef.current?.focus({ preventScroll: true });
        return keepInClearView(addButtonRef.current);
        // Only a new request should move focus, not every change of row.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusRequests]);

    // The screen opening scrolls itself to the top (X56), so the browser shouldn't also scroll to the field.
    useEffect(() => {
        if (autoFocusOnMount) {
            activeInputRef.current?.focus({ preventScroll: true });
        }
    }, [autoFocusOnMount]);

    const requestFocus = () => {
        setFocusRequests((count) => count + 1);
    };

    const updateCardValue = (index, value) => {
        const updated = [...cards];
        updated[index] = sanitizeTypedCard({ ...updated[index], value });
        onCardsChange(updated);
    };

    // A typed 0 only becomes The Zero here, as that replaces the field and closes the keyboard (X42).
    const settleCard = (index) => {
        const settled = sanitizeCard(cards[index], gameMode);
        if (settled.type === cards[index].type) {
            return;
        }

        const updated = [...cards];
        updated[index] = settled;
        onCardsChange(updated);
    };

    const updateCardType = (index, option) => {
        const updated = [...cards];
        updated[index] = retypeCard(updated[index], option, gameMode);
        onCardsChange(updated);
    };

    // A switch to a type that still needs its value goes straight to typing it. A special has no
    // value and a filled row is done, so neither opens the keyboard (X39).
    const handleSwitchType = (option) => {
        if (option === cardTypeOption(cards[activeIndex])) {
            return;
        }

        const switched = switchCardType(cards, activeIndex, option, gameMode);
        onCardsChange(switched.cards);
        setChosenIndex(switched.index);
        if (switched.cards[switched.index].value === '') {
            requestFocus();
        }
    };

    // A double tap can't have typed anything, so a filled last row is never a double tap.
    const handleAddNextCard = () => {
        const now = Date.now();
        const isDoubleTap = lastAddTimeRef.current !== null
            && now - lastAddTimeRef.current < DOUBLE_TAP_MS
            && cards[lastIndex]?.value === '';
        if (isDoubleTap) {
            return;
        }

        lastAddTimeRef.current = now;
        onCardsChange(addNextCard(sanitizeCards(cards, gameMode)));
        setChosenIndex(null);
        requestFocus();
    };

    const removeCard = (index) => {
        const updated = cards.filter((_, i) => i !== index);
        onCardsChange(updated);
        setChosenIndex(null);
    };

    const handleKeyDown = (index, e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            onCardsChange(addCard(sanitizeCards(cards, gameMode), cards[index].type));
            setChosenIndex(null);
            requestFocus();
        }
    };

    const handleWheel = (e) => {
        e.preventDefault();
    };

    return (
        <>
            <div className="space-y-2 mb-3">
                {cards.map((card, index) => (
                    <div
                        key={index}
                        className={`flex items-center gap-1 sm:gap-2 rounded-lg p-2 ring-1 ${
                            pastSeven.has(index) ? 'bg-red-100' : 'bg-slate-50'
                        } ${index === activeIndex ? 'ring-slate-400' : 'ring-transparent'}`}
                    >
                        <select
                            aria-label={`Card ${index + 1} type`}
                            value={cardTypeOption(card)}
                            onFocus={() => setChosenIndex(index)}
                            onChange={(e) => updateCardType(index, e.target.value)}
                            className={`shrink-0 px-2 sm:px-3 py-1.5 rounded-lg border-2 text-xs sm:text-sm font-semibold transition-colors ${
                                typeStyle(card.type).picker
                            }`}
                        >
                            {cardTypeOptions(gameMode, card).map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                            ))}
                        </select>
                        {card.type === 'special' ? (
                            // The type carries the meaning and there is nothing to type, so no input.
                            <span className="flex-1 min-w-0 px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-semibold text-rose-900">
                                {specialCardLabel(card.value)}
                            </span>
                        ) : (
                            <input
                                aria-label={`Card ${index + 1} value`}
                                ref={index === activeIndex ? activeInputRef : null}
                                onFocus={() => setChosenIndex(index)}
                                type="number"
                                inputMode="numeric"
                                pattern="[0-9]*"
                                value={card.value}
                                onChange={(e) => updateCardValue(index, e.target.value)}
                                onBlur={() => settleCard(index)}
                                onKeyDown={(e) => handleKeyDown(index, e)}
                                onWheel={handleWheel}
                                placeholder={card.type === 'number' ? '0' : ''}
                                className={`flex-1 min-w-0 px-2 sm:px-3 py-1.5 rounded-lg border-2 bg-white text-xs sm:text-sm font-mono transition-colors focus:outline-none ${
                                    typeStyle(card.type).input
                                }`}
                            />
                        )}
                        <Button
                            aria-label={`Remove card ${index + 1}`}
                            variant="ghost"
                            size="sm"
                            onClick={() => removeCard(index)}
                            className="shrink-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                        >
                            <X className="w-4 h-4" />
                        </Button>
                    </div>
                ))}
            </div>
            {cards.length > 0 && (
                <CardTypeSwitcher cards={cards} activeIndex={activeIndex} gameMode={gameMode} onSwitch={handleSwitchType} />
            )}
            <button
                ref={addButtonRef}
                type="button"
                onClick={handleAddNextCard}
                className="flex items-center justify-center gap-2 w-full h-12 mb-4 rounded-xl border-2 border-ui-accent-border bg-ui-accent-soft text-ui-accent font-semibold transition-colors hover:bg-ui-accent-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-ui-accent-vivid"
            >
                <Plus className="w-5 h-5" strokeWidth={2.5} aria-hidden="true" />
                Add card
            </button>
        </>
    );
}
