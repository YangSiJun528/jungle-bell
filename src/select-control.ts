import Alpine from 'alpinejs';

interface SelectOption {
    value: string;
    label: string;
    disabled: boolean;
}

let selectControlId = 0;

function selectControl() {
    const id = `jungle-select-${++selectControlId}`;

    return {
        open: false,
        options: [] as SelectOption[],
        selectedValue: '',
        selectedLabel: '',
        listboxId: `${id}-listbox`,

        init(this: any) {
            this.$nextTick(() => {
                const native = this.$refs.native as HTMLSelectElement;
                this.options = Array.from(native.options).map((option) => ({
                    value: option.value,
                    label: option.textContent ?? option.value,
                    disabled: option.disabled,
                }));
                this.syncValue(native.value);
            });
        },

        syncValue(this: any, value: string | number) {
            const stringValue = String(value);
            this.selectedValue = stringValue;
            this.selectedLabel = this.options.find((option: SelectOption) => option.value === stringValue)?.label ?? '';
        },

        isDisabled(this: any): boolean {
            return Boolean((this.$refs.native as HTMLSelectElement)?.disabled);
        },

        toggle(this: any) {
            if (this.isDisabled()) return;
            if (this.open) this.close();
            else this.openMenu();
        },

        openMenu(this: any) {
            if (this.isDisabled()) return;
            this.open = true;
            this.$nextTick(() => this.focusSelected());
        },

        close(this: any, returnFocus = false) {
            this.open = false;
            if (returnFocus) this.$nextTick(() => (this.$refs.trigger as HTMLButtonElement).focus());
        },

        choose(this: any, value: string) {
            const native = this.$refs.native as HTMLSelectElement;
            if (native.disabled) return;
            native.value = value;
            native.dispatchEvent(new Event('change', {bubbles: true}));
            this.syncValue(value);
            this.close(true);
        },

        optionButtons(this: any): HTMLButtonElement[] {
            return Array.from((this.$root as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="option"]'))
                .filter((button) => !button.disabled);
        },

        focusSelected(this: any) {
            const buttons = this.optionButtons();
            const selected = buttons.find((button: HTMLButtonElement) => button.dataset.value === this.selectedValue);
            (selected ?? buttons[0])?.focus();
        },

        move(this: any, delta: number) {
            const buttons = this.optionButtons();
            if (buttons.length === 0) return;
            const current = Math.max(0, buttons.indexOf(document.activeElement as HTMLButtonElement));
            buttons[(current + delta + buttons.length) % buttons.length].focus();
        },

        focusEdge(this: any, edge: 'first' | 'last') {
            const buttons = this.optionButtons();
            (edge === 'first' ? buttons[0] : buttons[buttons.length - 1])?.focus();
        },

        handleTriggerKey(this: any, event: KeyboardEvent) {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            this.openMenu();
            this.$nextTick(() => {
                if (event.key === 'Home') this.focusEdge('first');
                else if (event.key === 'End') this.focusEdge('last');
                else if (event.key === 'ArrowUp') this.focusEdge('last');
            });
        },

        handleOptionKey(this: any, event: KeyboardEvent) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                this.move(event.key === 'ArrowDown' ? 1 : -1);
            } else if (event.key === 'Home' || event.key === 'End') {
                event.preventDefault();
                this.focusEdge(event.key === 'Home' ? 'first' : 'last');
            } else if (event.key === 'Enter' || event.key === ' ') {
                const option = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="option"]');
                if (!option?.dataset.value) return;
                event.preventDefault();
                this.choose(option.dataset.value);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                this.close(true);
            } else if (event.key === 'Tab') {
                this.close();
            }
        },
    };
}

Alpine.data('selectControl', selectControl);
