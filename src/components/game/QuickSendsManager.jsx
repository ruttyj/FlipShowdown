import React, { useState } from 'react';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import { GripVertical, Trash2, Edit2, Check, X } from 'lucide-react';
import BackButton from '@/components/ui/BackButton';
import { motion } from 'framer-motion';
import { MAX_QUICK_SENDS, quickSendRecipientIds } from '@/lib/quickSends';

// The grip the user drags a row by. @hello-pangea/dnd needs one in every row, in edit mode too,
// otherwise it logs an invariant and touch dragging has nothing to grab.
function DragHandle({ dragHandleProps, label }) {
    return (
        <div
            {...dragHandleProps}
            aria-label={`Reorder ${label}`}
            className="text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing flex-shrink-0"
        >
            <GripVertical className="w-4 h-4" />
        </div>
    );
}

// Where the row at `index` ends up after the row at `from` is moved to `to`.
function indexAfterMove(index, from, to) {
    if (index === from) {
        return to;
    }

    if (from < index && index <= to) {
        return index - 1;
    }

    if (to <= index && index < from) {
        return index + 1;
    }
    return index;
}

// "Everyone" for a default combo, otherwise the names of the recipients still in the room.
function recipientSummary(combo, otherPlayers) {
    if (combo.toEveryone) {
        return 'Everyone';
    }

    const names = [];
    for (const id of quickSendRecipientIds(combo, otherPlayers)) {
        names.push(otherPlayers.find(p => p.id === id).name);
    }
    return names.join(', ') || 'No recipients';
}

export default function QuickSendsManager({ quickSends, otherPlayers, onBack, onDelete, onUpdate, onReorder }) {
    const [editingIndex, setEditingIndex] = useState(null);
    const [editEmoji, setEditEmoji] = useState('');
    const [editMessage, setEditMessage] = useState('');
    const [editRecipients, setEditRecipients] = useState([]);

    const startEdit = (i, qs) => {
        setEditingIndex(i);
        setEditEmoji(qs.emoji);
        setEditMessage(qs.message || '');
        setEditRecipients(quickSendRecipientIds(qs, otherPlayers));
    };

    const cancelEdit = () => setEditingIndex(null);

    // Saving turns an everyone-default into a plain recipients list, as chosen on screen.
    const saveEdit = () => {
        if (!editEmoji) {
            return;
        }
        onUpdate(editingIndex, { emoji: editEmoji, message: editMessage, recipients: editRecipients, toEveryone: false });
        setEditingIndex(null);
    };

    const toggleRecipient = (id) => {
        setEditRecipients(prev =>
            prev.includes(id) ? prev.filter(r => r !== id) : [...prev, id]
        );
    };

    const onDragEnd = (result) => {
        if (!result.destination) {
            return;
        }

        // The edit is tracked by index, so follow the row being edited to its new position.
        // Otherwise Save would overwrite whichever combo now sits at the old index.
        if (editingIndex !== null) {
            setEditingIndex(indexAfterMove(editingIndex, result.source.index, result.destination.index));
        }

        onReorder(result.source.index, result.destination.index);
    };

    return (
        <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'tween', duration: 0.22 }}
            className="absolute inset-0 bg-white flex flex-col z-10"
        >
            {/* Header */}
            <div className="bg-ui-accent text-ui-on-accent px-4 py-3 flex items-center gap-3 flex-shrink-0">
                <BackButton onClick={onBack} className="hover:bg-ui-accent-strong" />
                <span className="text-lg font-semibold">Quick Sends</span>
                <span className="text-ui-on-accent-muted text-sm ml-auto">{quickSends.length}/{MAX_QUICK_SENDS} saved</span>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
                {quickSends.length === 0 && (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400 gap-2">
                        <span className="text-4xl">💬</span>
                        <p className="text-sm">No quick sends saved yet.</p>
                        <p className="text-xs text-slate-300">Emoji you send in chat show up here.</p>
                    </div>
                )}

                <DragDropContext onDragEnd={onDragEnd}>
                    <Droppable droppableId="quick-sends">
                        {(provided) => (
                            <div ref={provided.innerRef} {...provided.droppableProps} className="p-3 space-y-2">
                                {quickSends.map((qs, i) => (
                                    <Draggable key={`${i}-${qs.emoji}`} draggableId={`qs-${i}`} index={i}>
                                        {(drag, snapshot) => (
                                            <div
                                                ref={drag.innerRef}
                                                {...drag.draggableProps}
                                                className={`rounded-xl border transition-shadow ${
                                                    snapshot.isDragging ? 'shadow-xl border-ui-accent-border-strong bg-ui-accent-soft' : 'border-slate-200 bg-white shadow-sm'
                                                }`}
                                            >
                                                {editingIndex === i ? (
                                                    /* Edit mode */
                                                    <div className="p-3 space-y-3">
                                                        <div className="flex items-center gap-2">
                                                            <DragHandle dragHandleProps={drag.dragHandleProps} label={qs.message || qs.emoji} />
                                                            <input
                                                                value={editEmoji}
                                                                onChange={e => setEditEmoji(e.target.value)}
                                                                className="w-14 text-2xl text-center border border-slate-200 rounded-lg p-1"
                                                                placeholder="😀"
                                                            />
                                                            <input
                                                                value={editMessage}
                                                                onChange={e => setEditMessage(e.target.value)}
                                                                placeholder="Optional message..."
                                                                className="flex-1 text-sm px-3 py-2 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-ui-accent-bright"
                                                            />
                                                        </div>
                                                        <div>
                                                            <p className="text-xs font-semibold text-slate-500 mb-1.5">Recipients</p>
                                                            <div className="flex flex-wrap gap-1.5">
                                                                {otherPlayers.map(p => (
                                                                    <button
                                                                        key={p.id}
                                                                        onClick={() => toggleRecipient(p.id)}
                                                                        className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                                                                            editRecipients.includes(p.id)
                                                                                ? 'bg-ui-accent text-ui-on-accent'
                                                                                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                                                                        }`}
                                                                    >
                                                                        {p.name}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                        </div>
                                                        <div className="flex gap-2">
                                                            <button
                                                                onClick={saveEdit}
                                                                className="flex-1 flex items-center justify-center gap-1 bg-ui-accent text-ui-on-accent text-sm py-1.5 rounded-lg hover:bg-ui-accent-strong transition-colors"
                                                            >
                                                                <Check className="w-3.5 h-3.5" /> Save
                                                            </button>
                                                            <button
                                                                onClick={cancelEdit}
                                                                className="flex-1 flex items-center justify-center gap-1 bg-slate-100 text-slate-600 text-sm py-1.5 rounded-lg hover:bg-slate-200 transition-colors"
                                                            >
                                                                <X className="w-3.5 h-3.5" /> Cancel
                                                            </button>
                                                        </div>
                                                    </div>
                                                ) : (
                                                    /* View mode */
                                                    <div className="flex items-center gap-2 px-3 py-2.5">
                                                        <DragHandle dragHandleProps={drag.dragHandleProps} label={qs.message || qs.emoji} />
                                                        <span className="text-2xl">{qs.emoji}</span>
                                                        <div className="flex-1 min-w-0">
                                                            {qs.message && <p className="text-sm text-slate-700 truncate">{qs.message}</p>}
                                                            <p className="text-xs text-slate-400">
                                                                → {recipientSummary(qs, otherPlayers)}
                                                            </p>
                                                        </div>
                                                        <button
                                                            onClick={() => startEdit(i, qs)}
                                                            aria-label="Edit quick send"
                                                            className="text-slate-400 hover:text-ui-accent transition-colors p-1"
                                                        >
                                                            <Edit2 className="w-4 h-4" />
                                                        </button>
                                                        <button
                                                            onClick={() => onDelete(i)}
                                                            aria-label="Delete quick send"
                                                            className="text-slate-400 hover:text-red-500 transition-colors p-1"
                                                        >
                                                            <Trash2 className="w-4 h-4" />
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </Draggable>
                                ))}
                                {provided.placeholder}
                            </div>
                        )}
                    </Droppable>
                </DragDropContext>
            </div>
        </motion.div>
    );
}