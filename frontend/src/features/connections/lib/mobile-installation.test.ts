import assert from 'node:assert/strict';
import {test} from 'vitest';
import {createMobileInstallationIdProvider} from './mobile-installation';

test('localStorage가 막혀도 한 페이지 생명주기에서 동일한 설치 ID를 재사용한다', () => {
    let randomCalls = 0;
    const installationId = createMobileInstallationIdProvider({
        read: () => { throw new Error('storage disabled'); },
        write: () => { throw new Error('storage disabled'); },
        randomBytes: (length) => {
            randomCalls += 1;
            return Uint8Array.from({length}, (_, index) => index);
        },
    });

    assert.equal(installationId(), 'jbmi_000102030405060708090a0b0c0d0e0f');
    assert.equal(installationId(), 'jbmi_000102030405060708090a0b0c0d0e0f');
    assert.equal(randomCalls, 1);
});

test('저장된 정상 설치 ID는 난수를 만들지 않고 메모리에 고정한다', () => {
    let reads = 0;
    const installationId = createMobileInstallationIdProvider({
        read: () => {
            reads += 1;
            return 'jbmi_fedcba9876543210fedcba9876543210';
        },
        write: () => { throw new Error('unexpected write'); },
        randomBytes: () => { throw new Error('unexpected random'); },
    });

    assert.equal(installationId(), 'jbmi_fedcba9876543210fedcba9876543210');
    assert.equal(installationId(), 'jbmi_fedcba9876543210fedcba9876543210');
    assert.equal(reads, 1);
});
