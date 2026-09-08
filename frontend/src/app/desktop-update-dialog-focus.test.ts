import {describe, expect, it, vi} from 'vitest';

import {activateBlockingDialogFocus} from './desktop-update-dialog-focus';

class FakeFocusable {
    isConnected = true;
    focus = vi.fn<() => void>();
}

class FakeDialog extends EventTarget {
    readonly first = new FakeFocusable();
    readonly last = new FakeFocusable();
    readonly self = new FakeFocusable();
    ownerDocument: {activeElement: unknown};

    constructor(activeElement: unknown) {
        super();
        this.ownerDocument = {activeElement};
    }

    focus(): void {
        this.self.focus();
        this.ownerDocument.activeElement = this;
    }

    contains(value: unknown): boolean {
        return value === this.first || value === this.last;
    }

    querySelectorAll(): FakeFocusable[] {
        return [this.first, this.last];
    }
}

function keyboardEvent(key: string, shiftKey = false): KeyboardEvent {
    return Object.assign(new Event('keydown', {cancelable: true}), {
        key,
        shiftKey,
    }) as KeyboardEvent;
}

describe('activateBlockingDialogFocus', () => {
    it('첫 조작 요소로 포커스를 옮기고 양방향 Tab을 dialog 안에서 순환시킨다', () => {
        const previous = new FakeFocusable();
        const dialog = new FakeDialog(previous);
        const cleanup = activateBlockingDialogFocus(
            dialog as unknown as HTMLDialogElement,
            (callback) => callback(),
        );

        expect(dialog.first.focus).toHaveBeenCalledOnce();

        dialog.ownerDocument.activeElement = dialog.last;
        const forward = keyboardEvent('Tab');
        dialog.dispatchEvent(forward);
        expect(forward.defaultPrevented).toBe(true);
        expect(dialog.first.focus).toHaveBeenCalledTimes(2);

        dialog.ownerDocument.activeElement = dialog.first;
        const backward = keyboardEvent('Tab', true);
        dialog.dispatchEvent(backward);
        expect(backward.defaultPrevented).toBe(true);
        expect(dialog.last.focus).toHaveBeenCalledOnce();

        cleanup();
        expect(previous.focus).toHaveBeenCalledOnce();
    });

    it('필수 업데이트 dialog는 Escape로 닫히지 않는다', () => {
        const dialog = new FakeDialog(new FakeFocusable());
        const cleanup = activateBlockingDialogFocus(
            dialog as unknown as HTMLDialogElement,
            (callback) => callback(),
        );
        const escape = keyboardEvent('Escape');

        dialog.dispatchEvent(escape);

        expect(escape.defaultPrevented).toBe(true);
        cleanup();
    });
});
