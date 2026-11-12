import { expect, test } from 'vitest';
import { errorMessage } from '../../src/renderer/errorMessage.js';

test("drops Electron's IPC prefix and the error class name", () => {
    const error = new Error("Error invoking remote method 'launcher:save-settings': TypeError: geminiModel is longer than 100 characters");

    expect(errorMessage(error)).toBe('geminiModel is longer than 100 characters');
});

test('keeps a plain error message as it is', () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full');
});

test('turns a thrown non-error into text', () => {
    expect(errorMessage('timed out')).toBe('timed out');
});
