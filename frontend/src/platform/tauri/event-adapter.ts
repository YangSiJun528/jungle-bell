import {listen} from '@tauri-apps/api/event';

import type {PlatformEventAdapter} from '@/platform/contracts';

export function createTauriEventAdapter(): PlatformEventAdapter {
    return {
        enabled: true,
        subscribeNotificationInboxUpdated: (listener) =>
            listen<unknown>('notification-inbox-updated', ({payload}) => listener(payload)),
        subscribeAttendanceSnapshotUpdated: (listener) =>
            listen<unknown>('attendance-snapshot-updated', ({payload}) => listener(payload)),
        subscribeLmsSessionStateUpdated: (listener) =>
            listen<unknown>('lms-session-state-updated', ({payload}) => listener(payload)),
    };
}
