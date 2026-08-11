export interface VisibilityDocument {
    readonly visibilityState: DocumentVisibilityState;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export function documentIsVisible(source: VisibilityDocument = document): boolean {
    return source.visibilityState === 'visible';
}

export function subscribeToDocumentVisibility(
    onStoreChange: () => void,
    source: VisibilityDocument = document,
): () => void {
    source.addEventListener('visibilitychange', onStoreChange);
    return () => source.removeEventListener('visibilitychange', onStoreChange);
}
