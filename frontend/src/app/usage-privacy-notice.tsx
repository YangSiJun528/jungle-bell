import {useState} from 'react';
import {Link} from '@tanstack/react-router';
import {Info} from 'lucide-react';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';

const NOTICE_KEY = 'jungle-bell:usage-privacy-notice:v1';

function shouldShowNotice(): boolean {
    try {
        return window.localStorage.getItem(NOTICE_KEY) !== 'dismissed';
    } catch {
        return true;
    }
}

export function UsagePrivacyNotice() {
    const [visible, setVisible] = useState(shouldShowNotice);
    if (!visible) return null;

    const dismiss = () => {
        try {
            window.localStorage.setItem(NOTICE_KEY, 'dismissed');
        } catch {
            // 저장소가 차단되어도 안내를 닫는 동작은 유지한다.
        }
        setVisible(false);
    };

    return (
        <Alert className="border-primary/20 bg-primary/5">
            <Info aria-hidden="true"/>
            <AlertTitle>사용 통계 처리 방식이 바뀌었습니다.</AlertTitle>
            <AlertDescription>
                <p>외부 분석 도구 없이 일별 방문과 정해진 기능의 성공 횟수만 자체 서버에서 집계합니다.</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button asChild size="sm" variant="outline">
                        <Link to="/privacy">처리 내용 보기</Link>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={dismiss}>확인</Button>
                </div>
            </AlertDescription>
        </Alert>
    );
}
