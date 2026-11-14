import { requireBoolean } from './scoreBody.js';

/** set-edit-mode: turns the host's edit mode on or off (see ScoringService#setEditMode). */
export class SetEditModeAction {
    name = 'set-edit-mode';
    access = 'host';
    allowedStatuses = ['playing'];

    constructor({ scoringService }) {
        this.scoringService = scoringService;
    }

    handle(work, body) {
        this.scoringService.setEditMode(work, requireBoolean(body, 'on'));
    }
}
