import React from 'react';
import { motion, useReducedMotion } from 'framer-motion';

// The fan, left to right. The gold centre card is last in the deal so its flip lands as the finishing
// beat. It carries the app's own emblem, the icon's two tilted cards, not a number: a big gold 7 above
// FLIP would spell out the publisher's mark (X73).
const FAN = [
    { value: 2, x: -92, y: 20, rotate: -17, dealOrder: 0 },
    { value: 12, x: 92, y: 20, rotate: 17, dealOrder: 1 },
    { value: 5, x: -50, y: 8, rotate: -9, dealOrder: 2 },
    { value: 9, x: 50, y: 8, rotate: 9, dealOrder: 3 },
    { value: null, x: 0, y: 0, rotate: 0, dealOrder: 4, isHero: true },
];

const DEAL_STAGGER_SECONDS = 0.07;
const FLIP_DELAY_SECONDS = 0.4;
const DEAL_SPRING = { type: 'spring', stiffness: 170, damping: 20 };
const FLIP_SPRING = { type: 'spring', stiffness: 120, damping: 16 };

function CardFace({ value, isHero }) {
    if (isHero) {
        return (
            <span className="home-card-side home-card-face-hero">
                <span className="home-card-frame" />
                <span className="home-card-corner home-card-corner-top"><span className="home-card-pip" /></span>
                <span className="home-card-emblem" data-testid="home-hero-mark">
                    <span className="home-card-emblem-back" />
                    <span className="home-card-emblem-front" />
                </span>
                <span className="home-card-corner home-card-corner-bottom"><span className="home-card-pip" /></span>
                <span className="home-card-sheen" />
            </span>
        );
    }

    return (
        <span className="home-card-side home-card-face">
            <span className="home-card-corner home-card-corner-top">{value}</span>
            <span className="home-card-numeral">{value}</span>
            <span className="home-card-corner home-card-corner-bottom">{value}</span>
        </span>
    );
}

function CardBack() {
    return (
        <span className="home-card-side home-card-back">
            <span className="home-card-back-medallion">
                <span className="home-card-back-mark" />
            </span>
        </span>
    );
}

/**
 * One card: the outer layer deals it to its place in the fan, the inner one turns it face up. They
 * are separate so the flip turns about the card's own axis rather than the tilted fan's.
 */
function HeroCard({ card, prefersReducedMotion }) {
    const pose = { x: card.x, y: card.y, rotate: card.rotate, opacity: 1 };
    const dealDelay = card.dealOrder * DEAL_STAGGER_SECONDS;

    const dealInitial = prefersReducedMotion ? false : { x: 0, y: 60, rotate: 0, opacity: 0 };
    const flipInitial = prefersReducedMotion ? false : { rotateY: 180 };

    return (
        <motion.span
            className={`home-card ${card.isHero ? 'home-card-hero' : ''}`}
            initial={dealInitial}
            animate={pose}
            transition={{ ...DEAL_SPRING, delay: dealDelay }}
        >
            <motion.span
                className="home-card-turner"
                initial={flipInitial}
                animate={{ rotateY: 0 }}
                transition={{ ...FLIP_SPRING, delay: dealDelay + FLIP_DELAY_SECONDS }}
            >
                <CardFace value={card.value} isHero={card.isHero} />
                <CardBack />
            </motion.span>
        </motion.span>
    );
}

/** Home's centrepiece: a hand of cards dealt out and turned over. Decoration only. */
export default function HeroCards() {
    const prefersReducedMotion = useReducedMotion();

    return (
        <div className="home-fan" data-testid="home-hero-cards" aria-hidden="true">
            <div className="home-fan-glow" />
            {FAN.map((card) => (
                <HeroCard key={card.dealOrder} card={card} prefersReducedMotion={prefersReducedMotion} />
            ))}
        </div>
    );
}
