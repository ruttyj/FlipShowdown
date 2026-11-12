// One function per server game action (see "Game API" in docs/backend-contract.md).
// Each resolves with the action response and rejects with `Error{status, data}`,
// where `data.code` is the server's error code.

import { request } from './httpClient.js';

function roomPath(roomId, suffix = '') {
    return `/api/rooms/${encodeURIComponent(roomId)}${suffix}`;
}

function postAction(roomId, name, body = {}) {
    return request('POST', roomPath(roomId, `/actions/${name}`), { body });
}

export const game = {
    /**
     * @param {{ max_score: number, name?: string, game_mode?: string }} room  name defaults to the
     *        account name and game_mode to classic
     */
    createRoom: ({ max_score, name, game_mode }) =>
        request('POST', '/api/rooms', { body: { max_score, name, game_mode } }),
    lookupRoom: (code) => request('GET', `/api/rooms/by-code/${encodeURIComponent(code)}`),
    join: (roomId, { name }) => postAction(roomId, 'join', { name }),
    leave: (roomId) => postAction(roomId, 'leave'),
    kick: (roomId, playerId) => postAction(roomId, 'kick', { player_id: playerId }),
    makeHost: (roomId, playerId) => postAction(roomId, 'make-host', { player_id: playerId }),
    reorder: (roomId, playerIds) => postAction(roomId, 'reorder', { player_ids: playerIds }),
    setGameMode: (roomId, gameMode) => postAction(roomId, 'set-game-mode', { game_mode: gameMode }),
    start: (roomId) => postAction(roomId, 'start'),
    /**
     * @param {string} roomId
     * @param {{ round_number: number, cards: object[], base_sum: number, final_score: number, game_mode?: string, busted?: boolean, duplicate_allowed?: boolean, flip7_attack_player_id?: string }} score
     *        game_mode is the mode the score was worked out under, which the server checks
     */
    submitScore: (roomId, { round_number, cards, base_sum, final_score, game_mode, busted, duplicate_allowed, flip7_attack_player_id }) =>
        postAction(roomId, 'submit-score', { round_number, cards, base_sum, final_score, game_mode, busted, duplicate_allowed, flip7_attack_player_id }),
    retractScore: (roomId, roundNumber) => postAction(roomId, 'retract-score', { round_number: roundNumber }),
    forceNextRound: (roomId, roundNumber) =>
        postAction(roomId, 'force-next-round', { round_number: roundNumber }),
    setEditMode: (roomId, on) => postAction(roomId, 'set-edit-mode', { on }),
    /**
     * @param {string} roomId
     * @param {{ player_id: string, round_number: number, cards: object[], base_sum: number, final_score: number, game_mode?: string, busted?: boolean, duplicate_allowed?: boolean, flip7_attack_player_id?: string }} score
     */
    editScore: (roomId, { player_id, round_number, cards, base_sum, final_score, game_mode, busted, duplicate_allowed, flip7_attack_player_id }) =>
        postAction(roomId, 'edit-score', { player_id, round_number, cards, base_sum, final_score, game_mode, busted, duplicate_allowed, flip7_attack_player_id }),
    endGame: (roomId) => postAction(roomId, 'end-game'),
    reopenGame: (roomId) => postAction(roomId, 'reopen-game'),
    playAgain: (roomId) => postAction(roomId, 'play-again'),
    setGamesWon: (roomId, wins) => postAction(roomId, 'set-games-won', { wins }),
    closeRoom: (roomId) => postAction(roomId, 'close'),
    deleteRoom: (roomId) => postAction(roomId, 'delete'),
    // Admin only (403 not_admin otherwise). Resolves with { deleted_room_ids }.
};
