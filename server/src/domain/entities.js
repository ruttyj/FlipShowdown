// Entity names and room status lists shared across the server. Plain values; imports nothing.

export const ROOM = 'GameRoom';
export const PLAYER = 'Player';
export const ROUND_SCORE = 'RoundScore';
export const CHAT_MESSAGE = 'ChatMessage';

/** Every status except `closed`. */
export const OPEN_STATUSES = ['waiting', 'playing', 'finished'];

/**
 * The "caller" of system actions (access 'system'). It has no email, so it
 * is never a member, host or admin.
 */
export const SYSTEM_USER = Object.freeze({ email: null });
