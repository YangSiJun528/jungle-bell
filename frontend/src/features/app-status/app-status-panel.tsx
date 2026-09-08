import {Card} from '@/components/ui/card';

import {appStatusRows, type AppStatusInput, type AppStatusTab} from './app-status-model';
import {AppStatusRow} from './app-status-row';

const SURFACE_DESCRIPTION: Record<AppStatusInput['surface'], string> = {
    desktop: 'PC 로그인, 서버 연결, 동기화와 연결된 기기 상태를 확인합니다.',
    pwa: '현재 PWA 세션과 알림 준비 상태를 확인합니다.',
    web: '일반 웹에서 사용할 수 있는 기능과 PWA 설치 상태를 확인합니다.',
};

export function AppStatusPanel({
    input,
    onOpenTab,
}: {
    input: AppStatusInput;
    onOpenTab?: (tab: AppStatusTab) => void;
}) {
    const rows = appStatusRows(input);
    return (
        <section className="space-y-4" aria-labelledby="app-status-title">
            <div>
                <h2 id="app-status-title" className="text-lg font-semibold">
                    앱 상태
                </h2>
                <p className="mt-1 text-sm leading-6 text-muted-foreground">
                    {SURFACE_DESCRIPTION[input.surface]}
                </p>
            </div>
            <Card className="gap-0 overflow-hidden py-0">
                <ul className="divide-y">
                    {rows.map((row) => (
                        <AppStatusRow key={row.id} row={row} onOpenTab={onOpenTab} />
                    ))}
                </ul>
            </Card>
        </section>
    );
}
