/**
 * The "Holding" line of a vote button: the holders' names joined with commas, in holder
 * order. `holderNames` maps player id to name; an id with no name shows as "?".
 */
export function holderLabel(holderIds, holderNames) {
    const names = [];
    for (const id of holderIds) {
        names.push(holderNames?.[id] ?? '?');
    }
    return names.join(', ');
}
