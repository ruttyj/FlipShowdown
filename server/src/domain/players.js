// Pure rules about Player records that the game services and the realtime hub both need. Plain
// functions on plain records; imports nothing.

/** Whether `player` is the host of `room` (a GameRoom record). */
export function isHostPlayer(room, player) {
    // Older rooms have no host_player_id, so the email decides there.
    return room.host_player_id === player.id || room.host_email === player.email;
}
