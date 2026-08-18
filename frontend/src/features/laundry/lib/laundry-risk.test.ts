import {describe, expect, it} from 'vitest';
import {laundryRiskNotice} from './laundry-risk';

describe('laundryRiskNotice', () => {
    it('safe risk does not produce a visible notice', () => {
        expect(laundryRiskNotice({attempts: 10, errors: 1, rate: 10, riskLevel: 'safe'}))
            .toBeNull();
    });

    it('formats slight risk with retry guidance', () => {
        expect(laundryRiskNotice({attempts: 6, errors: 1, rate: 16.7, riskLevel: 'slight'}))
            .toEqual({
                label: '약간 주의',
                summary: '6번 중 에러 1번 · 에러율 16.7%',
                description: '오류가 반복되면 다른 기기를 이용하세요.',
            });
    });

    it('recommends another machine for caution risk', () => {
        expect(laundryRiskNotice({attempts: 5, errors: 3, rate: 60, riskLevel: 'caution'}))
            .toEqual({
                label: '주의',
                summary: '5번 중 에러 3번 · 에러율 60%',
                description: '오류 가능성이 높아 다른 기기 이용을 권장합니다.',
            });
    });
});
