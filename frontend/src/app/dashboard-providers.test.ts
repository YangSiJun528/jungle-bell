import {QueryClient} from '@tanstack/react-query';
import {expect, test} from 'vitest';
import {handleAttendanceSnapshotUpdated} from './desktop-attendance-event';
import {queryKeys} from './dashboard-context';

test('업로드 완료 이벤트는 데스크톱 출석 캐시만 stale 처리한다', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.attendance('desktop'), {cohortId: 'old'});
    client.setQueryData(queryKeys.attendance('browser'), {cohortId: 'companion'});

    await handleAttendanceSnapshotUpdated(client, {revision: 1});

    expect(client.getQueryState(queryKeys.attendance('desktop'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.attendance('browser'))?.isInvalidated).toBe(false);
});

test('잘못된 업로드 이벤트는 출석 캐시를 갱신하지 않는다', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.attendance('desktop'), {cohortId: 'old'});

    await handleAttendanceSnapshotUpdated(client, {revision: 0});

    expect(client.getQueryState(queryKeys.attendance('desktop'))?.isInvalidated).toBe(false);
});
