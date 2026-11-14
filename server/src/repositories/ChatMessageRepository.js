import { ENTITY_TABLES } from '../database/entityTables.js';
import { TableRepository } from './TableRepository.js';

// The chat_messages table. The generic entities API uses the inherited CRUD (chat is created
// through it); listByRoom is the query the room delete cascade needs.

export class ChatMessageRepository extends TableRepository {
    /** `database` is a Database. Chat messages reference no user, so there are no options. */
    constructor(database) {
        super(database, ENTITY_TABLES.get('ChatMessage'));
    }

    /** The room's messages, oldest first. */
    listByRoom(roomId) {
        return this.find('room_id', roomId);
    }
}
