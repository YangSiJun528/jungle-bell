import {invoke} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';

export const ALERT_OVERLAY_UPDATED_EVENT = 'alert-overlay-updated';

export type AlertOverlayAction = 'openAttendance' | 'openLaundry' | 'openMeals';

export interface AlertOverlayItem {
    id: string;
    title: string;
    body: string;
    createdAt: number;
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

export function alertActionLabel(action: AlertOverlayAction): string {
    return {
        openAttendance: '출석 열기',
        openLaundry: '워시타워 열기',
        openMeals: '식단 열기',
    }[action];
}

export function alertTimeLabel(createdAt: number): string {
    const date = new Date(createdAt);
    if (!Number.isFinite(date.getTime())) return '';
    return new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).format(date);
}

export function alertFocusTargetAfterDismiss(
    alerts: readonly Pick<AlertOverlayItem, 'id'>[],
    dismissedId: string,
): string | null {
    const dismissedIndex = alerts.findIndex((alert) => alert.id === dismissedId);
    if (dismissedIndex < 0) return null;

    return alerts[dismissedIndex + 1]?.id
        ?? alerts[dismissedIndex - 1]?.id
        ?? null;
}

export function alertFocusTargetAfterSnapshot(
    alerts: readonly Pick<AlertOverlayItem, 'id'>[],
    focusedId: string | null,
): string | null {
    if (!focusedId) return null;
    return alerts.some((alert) => alert.id === focusedId) ? focusedId : null;
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
            || !Number.isSafeInteger(item.createdAt)
            || (item.createdAt ?? 0) <= 0
            || (item.createdAt ?? 0) > 8_640_000_000_000_000
            || !isAlertOverlayAction(item.action)) {
            return null;
        }
        alerts.push({
            id: item.id,
            title: item.title,
            body: item.body,
            createdAt: item.createdAt as number,
            action: item.action,
        });
    }

    return {
        revision: candidate.revision as number,
        alerts,
    };
}

function startAlertOverlay(): void {
    const list = document.querySelector<HTMLUListElement>('[data-alert-list]');
    const total = document.querySelector<HTMLElement>('[data-alert-total]');
    const announcer = document.querySelector<HTMLElement>('[data-alert-announcer]');
    const template = document.querySelector<HTMLTemplateElement>('[data-alert-item-template]');
    if (!list || !total || !announcer || !template) return;

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
            announcer.textContent = '알림을 열지 못했어요';
            open.disabled = false;
            close.disabled = false;
        }
    };

    const dismissAlert = async (
        id: string,
        open: HTMLButtonElement,
        close: HTMLButtonElement,
    ) => {
        if (open.disabled || close.disabled) return;
        const focusTargetId = alertFocusTargetAfterDismiss(alerts, id);
        open.disabled = true;
        close.disabled = true;
        try {
            applySnapshot(
                await invoke<AlertOverlaySnapshot>('dismiss_alert_overlay', {id}),
                focusTargetId,
            );
        } catch (error) {
            console.error('[alert-overlay] dismiss failed', error);
            announcer.textContent = '알림을 닫지 못했어요';
            open.disabled = false;
            close.disabled = false;
        }
    };

    const renderAlerts = (
        focusTargetId: string | null = null,
        focusTargetControl: 'open' | 'close' = 'open',
    ) => {
        let focusTarget: HTMLButtonElement | null = null;
        list.replaceChildren();
        total.textContent = `${alerts.length}개`;

        for (const alert of alerts) {
            const fragment = template.content.cloneNode(true) as DocumentFragment;
            const title = fragment.querySelector<HTMLElement>('[data-alert-item-title]');
            const body = fragment.querySelector<HTMLElement>('[data-alert-item-body]');
            const time = fragment.querySelector<HTMLTimeElement>('[data-alert-item-time]');
            const action = fragment.querySelector<HTMLElement>('[data-alert-item-action]');
            const open = fragment.querySelector<HTMLButtonElement>('[data-alert-item-open]');
            const close = fragment.querySelector<HTMLButtonElement>('[data-alert-item-close]');
            if (!title || !body || !time || !action || !open || !close) continue;

            const actionLabel = alertActionLabel(alert.action);
            title.textContent = alert.title;
            body.textContent = alert.body;
            time.dateTime = new Date(alert.createdAt).toISOString();
            time.textContent = alertTimeLabel(alert.createdAt);
            action.textContent = actionLabel;
            close.setAttribute('aria-label', `${alert.title} 알림 닫기`);
            open.dataset.alertId = alert.id;
            open.dataset.alertControl = 'open';
            close.dataset.alertId = alert.id;
            close.dataset.alertControl = 'close';
            if (alert.id === focusTargetId) {
                focusTarget = focusTargetControl === 'close' ? close : open;
            }
            open.addEventListener('click', () => {
                void activateAlert(alert.id, open, close);
            });
            close.addEventListener('click', () => {
                void dismissAlert(alert.id, open, close);
            });
            list.append(fragment);
        }

        focusTarget?.focus();
    };

    const applySnapshot = (value: unknown, focusTargetId: string | null = null) => {
        const snapshot = normalizeAlertOverlaySnapshot(value);
        if (!snapshot || snapshot.revision <= revision) return;
        const activeElement = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const activeAlertId = activeElement?.dataset.alertId ?? null;
        const activeControl = activeElement?.dataset.alertControl === 'close' ? 'close' : 'open';
        const preservedFocusTargetId = focusTargetId
            ?? alertFocusTargetAfterSnapshot(snapshot.alerts, activeAlertId);
        const preservedFocusControl = focusTargetId ? 'open' : activeControl;
        const previousIds = new Set(alerts.map((alert) => alert.id));
        const added = snapshot.alerts.filter((alert) => !previousIds.has(alert.id));
        if (revision >= 0 && added.length > 0) {
            announcer.textContent = added
                .map((alert) => `새 알림, ${alert.title}, ${alertActionLabel(alert.action)}`)
                .join('. ');
        }
        revision = snapshot.revision;
        alerts = snapshot.alerts;
        renderAlerts(preservedFocusTargetId, preservedFocusControl);
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
