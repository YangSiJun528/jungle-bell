import {readFileSync} from 'node:fs';
import {describe, expect, test} from 'vitest';
import type {DesktopConnectionState} from '@/api/dashboard-api';
import {desktopConnectionUiState} from './desktop-connection-state';

const connection = (state: DesktopConnectionState['state']): DesktopConnectionState => ({
    state,
    desktopId: state === 'connected' ? 'desktop_123' : null,
    lastVerifiedAt: null,
    lastSeenAt: null,
    health: state === 'connected' ? 'online' : null,
    lmsSessionState: 'unknown',
});

describe('desktop connection state UI', () => {
    test('connected와 자동 등록 가능한 disconnected는 pairing 생성을 허용한다', () => {
        expect(desktopConnectionUiState(connection('connected'))).toMatchObject({
            canCreatePairing: true,
            needsIdentityRecovery: false,
            label: '온라인',
        });
        expect(desktopConnectionUiState(connection('disconnected'))).toMatchObject({
            canCreatePairing: true,
            needsIdentityRecovery: false,
            label: '서버 등록 전',
        });
        expect(desktopConnectionUiState(connection('reset-required')).canCreatePairing).toBe(false);
        expect(desktopConnectionUiState(connection('unknown')).canCreatePairing).toBe(false);
    });

    test('disconnected는 자동 등록을 안내하고 reset-required만 identity 복구를 요구한다', () => {
        const disconnected = desktopConnectionUiState(connection('disconnected'));
        const resetRequired = desktopConnectionUiState(connection('reset-required'));

        expect(disconnected).toMatchObject({
            needsIdentityRecovery: false,
            label: '서버 등록 전',
        });
        expect(disconnected.reason).toContain('연결 코드를 만들면');
        expect(resetRequired).toMatchObject({
            needsIdentityRecovery: true,
            label: '초기화 필요',
        });
        expect(resetRequired.reason).toContain('일치하지 않');
    });

    test('연결 화면은 생성 mutation도 상태로 방어하고 identity 복구 CTA를 연결한다', () => {
        const source = readFileSync(new URL('./connections-page.tsx', import.meta.url), 'utf8');
        expect(source).toMatch(/connection\.data\?\.state !== 'connected'[\s\S]*connection\.data\?\.state !== 'disconnected'[\s\S]*DESKTOP_CONNECTION_REQUIRED/u);
        expect(source).toMatch(/!connectionUi\.canCreatePairing/u);
        expect(source).toMatch(/api\.resetDesktopIdentity\(\)/u);
        expect(source).toMatch(/invalidateQueries\(\{queryKey: queryKeys\.desktopConnection\}\)/u);
        expect(source).toContain('PC 연결 정보 복구');
    });
});
