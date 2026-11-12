import { modeCapabilities } from '../../shared/rules.js';

/** A room's mode. Stored rooms have no migration, so missing or unknown reads as classic. */
export function roomGameMode(room) {
    return modeCapabilities(room.game_mode).id;
}
