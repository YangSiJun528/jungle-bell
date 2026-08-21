import {beforeEach, expect, test, vi} from 'vitest';

import {createTauriEventAdapter} from './event-adapter';

const listen = vi.hoisted(() => vi.fn(async () => () => undefined));

vi.mock('@tauri-apps/api/event', () => ({listen}));

beforeEach(() => listen.mockClear());

test('서버 출석 업로드 완료 이벤트를 구독한다', async () => {
    const listener = vi.fn();

    await createTauriEventAdapter().subscribeAttendanceSnapshotUpdated(listener);

    expect(listen).toHaveBeenCalledWith('attendance-snapshot-updated', expect.any(Function));
});
