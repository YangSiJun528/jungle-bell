const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

type FocusTarget = {
    focus(options?: FocusOptions): void;
    isConnected?: boolean;
};

type ScheduleFocus = (callback: () => void) => void;

function canRestoreFocus(value: unknown): value is FocusTarget {
    return (
        typeof value === 'object' &&
        value !== null &&
        'focus' in value &&
        typeof value.focus === 'function'
    );
}

export function activateBlockingDialogFocus(
    dialog: HTMLDialogElement,
    scheduleFocus: ScheduleFocus = (callback) => queueMicrotask(callback),
): () => void {
    const previousFocus = dialog.ownerDocument.activeElement;
    let active = true;

    const focusableElements = (): HTMLElement[] =>
        Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    scheduleFocus(() => {
        if (!active) return;
        const first = focusableElements()[0];
        (first ?? dialog).focus({preventScroll: true});
    });

    const handleKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            return;
        }
        if (event.key !== 'Tab') return;

        const focusable = focusableElements();
        if (focusable.length === 0) {
            event.preventDefault();
            dialog.focus({preventScroll: true});
            return;
        }

        const first = focusable[0];
        const last = focusable.at(-1);
        const current = dialog.ownerDocument.activeElement;
        if (
            !dialog.contains(current) ||
            (event.shiftKey && current === first) ||
            (!event.shiftKey && current === last)
        ) {
            event.preventDefault();
            (event.shiftKey ? last : first)?.focus({preventScroll: true});
        }
    };

    dialog.addEventListener('keydown', handleKeyDown);
    return () => {
        active = false;
        dialog.removeEventListener('keydown', handleKeyDown);
        if (canRestoreFocus(previousFocus) && (previousFocus.isConnected ?? true)) {
            previousFocus.focus({preventScroll: true});
        }
    };
}
