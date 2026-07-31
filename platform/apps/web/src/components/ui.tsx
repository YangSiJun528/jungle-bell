import {
  Description,
  Dialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Field,
  Label,
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
  Switch,
} from "@headlessui/react";
import type { ReactNode } from "react";

export function SettingSwitch({
  checked,
  disabled = false,
  label,
  description,
  ariaLabel,
  compact = false,
  onChange,
}: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly ariaLabel?: string;
  readonly compact?: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <Field
      className={
        compact
          ? "setting-switch setting-switch--compact"
          : "setting-switch"
      }
      disabled={disabled}
    >
      <span className="setting-switch__copy">
        <Label className="setting-switch__label">{label}</Label>
        {description ? (
          <Description className="setting-switch__description">
            {description}
          </Description>
        ) : null}
      </span>
      <Switch
        aria-label={ariaLabel}
        checked={checked}
        className="ui-switch"
        onChange={onChange}
      >
        <span className="ui-switch__thumb" aria-hidden="true" />
      </Switch>
    </Field>
  );
}

export interface SelectControlOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly disabled?: boolean;
}

export function SelectControl<T extends string>({
  value,
  options,
  disabled = false,
  ariaLabel,
  emptyLabel = "선택 항목 없음",
  onChange,
}: {
  readonly value: T;
  readonly options: readonly SelectControlOption<T>[];
  readonly disabled?: boolean;
  readonly ariaLabel: string;
  readonly emptyLabel?: string;
  readonly onChange: (value: T) => void;
}) {
  const selected =
    options.find((option) => option.value === value) ?? null;
  return (
    <Listbox
      value={value}
      onChange={onChange}
      disabled={disabled}
    >
      <div className="ui-select">
        <ListboxButton
          aria-label={ariaLabel}
          className="ui-select__button"
        >
          <span className="ui-select__value">
            {selected?.label ?? emptyLabel}
          </span>
          <ChevronDownIcon />
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="ui-select__options"
        >
          {options.length === 0 ? (
            <ListboxOption
              className="ui-select__option"
              disabled
              value={value}
            >
              {emptyLabel}
            </ListboxOption>
          ) : (
            options.map((option) => (
              <ListboxOption
                className="ui-select__option"
                key={option.value}
                value={option.value}
                {...(option.disabled === undefined
                  ? {}
                  : { disabled: option.disabled })}
              >
                <span>{option.label}</span>
                <span
                  className="ui-select__check"
                  aria-hidden="true"
                >
                  ✓
                </span>
              </ListboxOption>
            ))
          )}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  busy = false,
  danger = false,
  onClose,
  onConfirm,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  readonly busy?: boolean;
  readonly danger?: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      className="ui-dialog"
      open={open}
      onClose={() => {
        if (!busy) {
          onClose();
        }
      }}
    >
      <DialogBackdrop transition className="ui-dialog__backdrop" />
      <div className="ui-dialog__viewport">
        <DialogPanel transition className="ui-dialog__panel">
          <DialogTitle className="ui-dialog__title">
            {title}
          </DialogTitle>
          <Description className="ui-dialog__description">
            {description}
          </Description>
          <div className="ui-dialog__actions">
            <button
              className="ui-button ui-button--secondary"
              disabled={busy}
              type="button"
              onClick={onClose}
            >
              취소
            </button>
            <button
              className={
                danger
                  ? "ui-button ui-button--danger"
                  : "ui-button ui-button--primary"
              }
              disabled={busy}
              type="button"
              onClick={onConfirm}
            >
              {busy ? "처리 중" : confirmLabel}
            </button>
          </div>
        </DialogPanel>
      </div>
    </Dialog>
  );
}

function ChevronDownIcon() {
  return (
    <svg
      className="ui-select__chevron"
      viewBox="0 0 20 20"
      aria-hidden="true"
    >
      <path
        d="m6 8 4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
      />
    </svg>
  );
}
