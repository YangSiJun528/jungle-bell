import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {test} from 'vitest';

type CapabilityPermission =
    | string
    | {
          identifier: string;
          allow?: Array<{url: string}>;
      };

const repoRoot = new URL('../../../../', import.meta.url);
const dashboardCapability = JSON.parse(
    readFileSync(new URL('desktop/capabilities/dashboard.json', repoRoot), 'utf8'),
) as {permissions: CapabilityPermission[]};
const desktopAppSource = readFileSync(new URL('desktop/src/lib.rs', repoRoot), 'utf8');

test('Tauri 대시보드는 검증된 프로젝트·LMS·급식 링크만 시스템 브라우저로 열 수 있다', () => {
    assert.match(desktopAppSource, /\.plugin\(tauri_plugin_opener::init\(\)\)/u);
    assert.equal(dashboardCapability.permissions.includes('opener:default'), false);
    assert.deepEqual(
        dashboardCapability.permissions.find(
            (permission) =>
                typeof permission !== 'string' && permission.identifier === 'opener:allow-open-url',
        ),
        {
            identifier: 'opener:allow-open-url',
            allow: [
                {url: 'https://github.com/YangSiJun528/jungle-bell'},
                {
                    url: 'https://github.com/YangSiJun528/jungle-bell#%EC%84%A4%EC%B9%98',
                },
                {url: 'https://github.com/YangSiJun528/jungle-bell/issues/new/choose'},
                {url: 'https://github.com/YangSiJun528/jungle-bell/releases/latest'},
                {url: 'https://jungle-lms.krafton.com/check-in'},
                {url: 'https://pf.kakao.com/_xhzNjn/*'},
                {
                    url: 'https://jungle-bell.sijun-yang.com/api/public/assets/*',
                },
            ],
        },
    );
});
