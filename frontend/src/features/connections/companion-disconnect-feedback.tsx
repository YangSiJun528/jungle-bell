import {CircleAlert, Smartphone} from 'lucide-react';

import type {PushSubscriptionCleanupResult} from '@/api/push-subscription-lifecycle';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';

import type {CompanionDisconnectOutcome} from './companion-disconnect';

export type CompanionDisconnectFeedback = CompanionDisconnectOutcome<PushSubscriptionCleanupResult> | null;

export function CompanionDisconnectFeedbackPanel({
    feedback,
    pending,
    onRetry,
}: {
    feedback: CompanionDisconnectFeedback;
    pending: boolean;
    onRetry: () => void;
}) {
    if (!feedback) return null;
    if (feedback.session === 'disconnected' && feedback.pushCleanup.status === 'complete') {
        return (
            <Alert aria-live="polite">
                <Smartphone aria-hidden="true" />
                <AlertTitle>연결 해제 완료</AlertTitle>
                <AlertDescription>
                    서버 푸시와 이 기기의 로컬 구독을 정리했습니다. 이제 공개 정보만 사용할 수
                    있습니다.
                </AlertDescription>
            </Alert>
        );
    }
    if (feedback.session === 'disconnected') {
        return (
            <Alert variant="destructive" aria-live="polite">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>연결 해제 완료 · 푸시 정리 미확인</AlertTitle>
                <AlertDescription>
                    연결 세션은 해제됐지만 푸시 정리는 모두 확인하지 못했습니다. 서버는 해제된
                    세션으로 더 이상 푸시를 보내지 않으며, 다시 연결한 뒤 등록 상태를 정리할 수
                    있습니다.
                </AlertDescription>
            </Alert>
        );
    }
    return (
        <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>연결 해제 실패</AlertTitle>
            <AlertDescription className="gap-3">
                <p>
                    {feedback.pushCleanup.status === 'complete'
                        ? '푸시 정리는 완료됐지만 연결은 유지됩니다. 다시 시도할 때 완료한 정리는 반복하지 않습니다.'
                        : '푸시 정리를 모두 확인하지 못했고 연결도 유지됩니다. 인증이 남아 있을 때 다시 시도하세요.'}
                </p>
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onRetry}
                    disabled={pending}
                >
                    다시 시도
                </Button>
            </AlertDescription>
        </Alert>
    );
}
