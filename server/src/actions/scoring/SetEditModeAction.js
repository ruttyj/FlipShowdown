import { requireBoolean } from './scoreBody.js';

/** set-edit-mode: turns the host's edit mode on or off (see ScoringService#setEditMode). */
export class SetEditModeAction {
    name = 'set-edit-mode';
    access = 'host';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoring = scoringService;
    }

    handle(work, body) {
        this.scoring.setEditMode(work, requireBoolean(body, 'on'));
    }
}
