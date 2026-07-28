import assert from 'node:assert/strict';
import {test} from 'vitest';

import {
    AUTO_UPDATE_DISABLE_CONFIRMATION,
    requiresAutoUpdateDisableConfirmation,
} from './settings-confirmation';

test('자동 업데이트를 끌 때만 외부 서비스 호환성 경고를 표시한다', () => {
    assert.equal(requiresAutoUpdateDisableConfirmation(false), true);
    assert.equal(requiresAutoUpdateDisableConfirmation(true), false);

    assert.equal(AUTO_UPDATE_DISABLE_CONFIRMATION.title, '자동 업데이트 끄기');
    assert.equal(AUTO_UPDATE_DISABLE_CONFIRMATION.okLabel, '그래도 끄기');
    assert.equal(AUTO_UPDATE_DISABLE_CONFIRMATION.cancelLabel, '취소');
    assert.equal(
        AUTO_UPDATE_DISABLE_CONFIRMATION.message,
        '자동 업데이트를 끄면 LMS 등 외부 서비스 변경으로 출석 확인이나 알림이 정상적으로 작동하지 않을 수 있습니다.\n'
        + '안정적인 사용을 위해 켜두는 것을 권장합니다.',
    );
});
