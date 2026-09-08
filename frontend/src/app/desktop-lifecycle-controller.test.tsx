import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';

import type {PlatformAdapter} from '@/platform/contracts';
import type {TauriLifecycleAdapter} from '@/platform/tauri/lifecycle';

import {
    DesktopLifecycleController,
    DesktopLifecycleSummary,
    desktopLifecycleTransition,
    initialDesktopLifecycleState,
    useDesktopLifecycleControls,
} from './desktop-lifecycle-controller';

const unseen = {
    closeBehavior: 'hideToTray',
    closeToTrayNotice: 'unseen',
    explicitQuitAvailable: true,
} as const;

const pending = {...unseen, closeToTrayNotice: 'pending'} as const;
const acknowledged = {...unseen, closeToTrayNotice: 'acknowledged'} as const;

describe('desktopLifecycleTransition', () => {
    it('앱 시작 시 저장된 pending 상태를 복구해 안내를 연다', () => {
        expect(
            desktopLifecycleTransition(initialDesktopLifecycleState, {
                type: 'status-loaded',
                status: pending,
            }),
        ).toMatchObject({status: pending, noticeOpen: true, phase: 'ready'});
    });

    it('close 이벤트 뒤 늦게 도착한 unseen 조회가 pending 안내를 덮어쓰지 않는다', () => {
        const afterEvent = desktopLifecycleTransition(initialDesktopLifecycleState, {
            type: 'close-requested',
            status: pending,
        });

        expect(
            desktopLifecycleTransition(afterEvent, {type: 'status-loaded', status: unseen}),
        ).toMatchObject({status: pending, noticeOpen: true});
    });

    it('확인 완료 상태는 안내를 닫고 이후 X의 tray hide 계약을 보존한다', () => {
        const open = desktopLifecycleTransition(initialDesktopLifecycleState, {
            type: 'close-requested',
            status: pending,
        });

        expect(
            desktopLifecycleTransition(open, {type: 'acknowledge-succeeded', status: acknowledged}),
        ).toMatchObject({status: acknowledged, noticeOpen: false, operation: 'idle'});
    });

    it('명령 실패 시 안내를 유지하고 재시도 가능한 오류를 노출한다', () => {
        const open = desktopLifecycleTransition(initialDesktopLifecycleState, {
            type: 'close-requested',
            status: pending,
        });
        const running = desktopLifecycleTransition(open, {type: 'acknowledge-started'});

        expect(desktopLifecycleTransition(running, {type: 'operation-failed'})).toMatchObject({
            noticeOpen: true,
            operation: 'idle',
            error: 'DESKTOP_LIFECYCLE_ACTION_FAILED',
        });
    });

    it('Controller 아래 production 소비자가 context hook으로 controls에 접근한다', () => {
        const platform = {
            kind: 'desktop',
            lifecycle: {
                getStatus: vi.fn<TauriLifecycleAdapter['getStatus']>(async () => unseen),
                acknowledgeAndHideToTray: vi.fn<TauriLifecycleAdapter['acknowledgeAndHideToTray']>(
                    async () => acknowledged,
                ),
                quit: vi.fn<TauriLifecycleAdapter['quit']>(async () => undefined),
                subscribeCloseToTrayNotice: vi.fn<
                    TauriLifecycleAdapter['subscribeCloseToTrayNotice']
                >(async () => () => undefined),
            },
        } as unknown as PlatformAdapter;
        function Consumer() {
            const controls = useDesktopLifecycleControls();
            return <output data-lifecycle-phase={controls.state.phase} />;
        }

        const markup = renderToStaticMarkup(
            <DesktopLifecycleController platform={platform}>
                <Consumer />
                <DesktopLifecycleSummary />
            </DesktopLifecycleController>,
        );

        expect(markup).toContain('data-lifecycle-phase="checking"');
        expect(markup).toContain('종료 동작 다시 보기');
    });
});
