import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';

export const ALERT_OVERLAY_UPDATED_EVENT = 'alert-overlay-updated';

export type AlertOverlayAction = 'openAttendance' | 'openLaundry' | 'openMeals';

export interface AlertOverlayItem {
    id: string;
    title: string;
    body: string;
    action: AlertOverlayAction;
}

export interface AlertOverlaySnapshot {
    revision: number;
    alerts: AlertOverlayItem[];
}

function isNonEmptyText(value: unknown, maxLength: number): value is string {
    return typeof value === 'string'
        && value.trim().length > 0
        && value.length <= maxLength
        && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value);
}

function isAlertOverlayAction(value: unknown): value is AlertOverlayAction {
    return value === 'openAttendance' || value === 'openLaundry' || value === 'openMeals';
}

export function normalizeAlertOverlaySnapshot(value: unknown): AlertOverlaySnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<AlertOverlaySnapshot>;
    if (!Number.isSafeInteger(candidate.revision) || (candidate.revision ?? -1) < 0 || !Array.isArray(candidate.alerts)) {
        return null;
    }

    const alerts: AlertOverlayItem[] = [];
    for (const alert of candidate.alerts) {
        if (!alert || typeof alert !== 'object') return null;
        const item = alert as Partial<AlertOverlayItem>;
        if (!isNonEmptyText(item.id, 32)
            || !/^\d+$/.test(item.id)
            || !isNonEmptyText(item.title, 200)
            || !isNonEmptyText(item.body, 1_000)
            || !isAlertOverlayAction(item.action)) {
            return null;
        }
        alerts.push({id: item.id, title: item.title, body: item.body, action: item.action});
    }

    return {
        revision: candidate.revision as number,
        alerts,
    };
}

function startAlertOverlay(): void {
    const list = document.querySelector<HTMLUListElement>('[data-alert-list]');
    const total = document.querySelector<HTMLElement>('[data-alert-total]');
    const template = document.querySelector<HTMLTemplateElement>('[data-alert-item-template]');
    if (!list || !total || !template) return;

    let revision = -1;
    let alerts: AlertOverlayItem[] = [];

    const activateAlert = async (
        id: string,
        open: HTMLButtonElement,
        close: HTMLButtonElement,
    ) => {
        if (open.disabled || close.disabled) return;
        open.disabled = true;
        close.disabled = true;
        try {
            applySnapshot(await invoke<AlertOverlaySnapshot>('activate_alert_overlay', {id}));
        } catch (error) {
            console.error('[alert-overlay] activate failed', error);
            open.disabled = false;
            close.disabled = false;
        }
    };

    const dismissAlert = async (id: string, close: HTMLButtonElement) => {
        if (close.disabled) return;
        close.disabled = true;
        try {
            applySnapshot(await invoke<AlertOverlaySnapshot>('dismiss_alert_overlay', {id}));
        } catch (error) {
            console.error('[alert-overlay] dismiss failed', error);
            close.disabled = false;
        }
    };

    const renderAlerts = () => {
        list.replaceChildren();
        total.textContent = `${alerts.length}개`;

        for (const alert of alerts) {
            const fragment = template.content.cloneNode(true) as DocumentFragment;
            const title = fragment.querySelector<HTMLElement>('[data-alert-item-title]');
            const body = fragment.querySelector<HTMLElement>('[data-alert-item-body]');
            const open = fragment.querySelector<HTMLButtonElement>('[data-alert-item-open]');
            const close = fragment.querySelector<HTMLButtonElement>('[data-alert-item-close]');
            if (!title || !body || !open || !close) continue;

            title.textContent = alert.title;
            body.textContent = alert.body;
            open.setAttribute('aria-label', `${alert.title} 알림 열기`);
            close.setAttribute('aria-label', `${alert.title} 알림 닫기`);
            open.addEventListener('click', () => {
                void activateAlert(alert.id, open, close);
            });
            close.addEventListener('click', () => {
                void dismissAlert(alert.id, close);
            });
            list.append(fragment);
        }
    };

    const applySnapshot = (value: unknown) => {
        const snapshot = normalizeAlertOverlaySnapshot(value);
        if (!snapshot || snapshot.revision < revision) return;
        revision = snapshot.revision;
        alerts = snapshot.alerts;
        renderAlerts();
    };

    void listen<AlertOverlaySnapshot>(ALERT_OVERLAY_UPDATED_EVENT, (event) => {
        applySnapshot(event.payload);
    }).catch((error) => console.error('[alert-overlay] event subscription failed', error));

    void invoke<AlertOverlaySnapshot>('get_alert_overlay_snapshot')
        .then(applySnapshot)
        .catch((error) => console.error('[alert-overlay] snapshot failed', error));
}

if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', startAlertOverlay, {once: true});
    } else {
        startAlertOverlay();
    }
}
