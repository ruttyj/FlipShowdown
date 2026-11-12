// The scorers behind the game modes live in the rule kernel, which the server shares. Every scorer
// accepts any stored card: a mode decides which cards can be added and scanned, but a card already in
// a hand is never rejected.

export { scoreClassic, scoreVengeance } from '../../shared/rules.js';

/** @typedef {import('../../shared/rules.js').ScoreOptions} ScoreOptions */
/** @typedef {import('../../shared/rules.js').HandScore} HandScore */
