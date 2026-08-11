import assert from 'node:assert/strict';
import {test} from 'vitest';
import {
    documentIsVisible,
    subscribeToDocumentVisibility,
} from './document-visibility';

test('document visibility subscription reports background and foreground transitions', () => {
    let visibilityState: DocumentVisibilityState = 'visible';
    let listener: (() => void) | null = null;
    let removed = false;
    const documentLike = {
        get visibilityState() { return visibilityState; },
        addEventListener: (_type: 'visibilitychange', callback: () => void) => { listener = callback; },
        removeEventListener: (_type: 'visibilitychange', callback: () => void) => {
            removed = callback === listener;
        },
    };
    const snapshots: boolean[] = [];
    const unsubscribe = subscribeToDocumentVisibility(
        () => snapshots.push(documentIsVisible(documentLike)),
        documentLike,
    );

    visibilityState = 'hidden';
    assert.ok(listener);
    (listener as () => void)();
    visibilityState = 'visible';
    (listener as () => void)();
    unsubscribe();

    assert.deepEqual(snapshots, [false, true]);
    assert.equal(removed, true);
});
