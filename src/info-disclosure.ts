export interface InfoDisclosure {
    title: string;
    detail: string;
    code?: string;
}

const OPEN_EVENT = 'info-disclosure-open';
const DISMISS_EVENT = 'info-disclosure-dismiss';
let nextId = 0;

interface InfoDisclosureState {
    id: string;
    hovered: boolean;
    focused: boolean;
    pinned: boolean;
    dismissed: boolean;
    readonly visible: boolean;
    announce(): void;
    enter(): void;
    leave(): void;
    focus(): void;
    blur(): void;
    toggle(): void;
    dismiss(): void;
    handlePeer(event: CustomEvent<string>): void;
}

export function dismissInfoDisclosures() {
    window.dispatchEvent(new Event(DISMISS_EVENT));
}

export function infoDisclosure(): InfoDisclosureState {
    const id = `info-disclosure-${++nextId}`;

    return {
        id,
        hovered: false,
        focused: false,
        pinned: false,
        dismissed: false,

        get visible() {
            return this.pinned || (!this.dismissed && (this.hovered || this.focused));
        },

        announce() {
            window.dispatchEvent(new CustomEvent(OPEN_EVENT, {detail: this.id}));
        },

        enter() {
            this.hovered = true;
            this.dismissed = false;
            this.announce();
        },

        leave() {
            this.hovered = false;
            if (!this.focused && !this.pinned) this.dismissed = false;
        },

        focus() {
            this.focused = true;
            this.dismissed = false;
            this.announce();
        },

        blur() {
            this.focused = false;
            if (!this.hovered && !this.pinned) this.dismissed = false;
        },

        toggle() {
            if (this.pinned) {
                this.pinned = false;
                this.dismissed = true;
                return;
            }
            this.pinned = true;
            this.dismissed = false;
            this.announce();
        },

        dismiss() {
            this.pinned = false;
            this.dismissed = true;
        },

        handlePeer(event: CustomEvent<string>) {
            if (event.detail === this.id) return;
            this.pinned = false;
            this.dismissed = true;
        },
    };
}
