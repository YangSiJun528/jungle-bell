import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import {notificationPanelBackgroundRoute} from './notification-panel-route';

const dashboardAppSource = readFileSync(new URL('./dashboard-app.tsx', import.meta.url), 'utf8');

describe('notification panel routing', () => {
    test('direct notification deep links keep home behind the panel', () => {
        expect(notificationPanelBackgroundRoute('home', 'notifications')).toBe('home');
    });

    test('opening notifications preserves the current dashboard screen', () => {
        expect(notificationPanelBackgroundRoute('meals', 'notifications')).toBe('meals');
        expect(notificationPanelBackgroundRoute('connections', 'notifications')).toBe('connections');
    });

    test('ordinary navigation immediately becomes the panel background', () => {
        expect(notificationPanelBackgroundRoute('home', 'laundry')).toBe('laundry');
    });

    test('UI triggers use local panel state while deep-link closing replaces only the notification route', () => {
        expect(dashboardAppSource).toContain('const {route, navigate, replace} = useHashRoute();');
        expect(dashboardAppSource).toContain("const notificationPanelOpen = route === 'notifications' || notificationPanelRequestedOpen;");
        expect(dashboardAppSource).toContain('setNotificationPanelRequestedOpen(open);');
        expect(dashboardAppSource).toContain("if (!open && route === 'notifications') replace(contentRoute);");
        expect(dashboardAppSource).toContain('}, [contentRoute]);');
    });
});
