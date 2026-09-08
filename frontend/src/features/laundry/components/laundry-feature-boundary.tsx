import type {ReactNode} from 'react';

import {AsyncBoundary} from '@/components/dashboard/async-boundary';
import {AsyncState, LoadingState, useOnlineStatus} from '@/components/dashboard/async-state';

export interface LaundryFeatureBoundaryProps {
    children: ReactNode;
}

/** Keeps laundry loading and query failures local when the feature is embedded elsewhere. */
export function LaundryFeatureBoundary({children}: LaundryFeatureBoundaryProps) {
    const isOnline = useOnlineStatus();

    return (
        <AsyncBoundary
            errorTitle="세탁실 상태를 불러오지 못했습니다."
            errorDescription="연결 상태를 확인한 뒤 다시 시도해 주세요."
            fallback={
                isOnline ? (
                    <LoadingState label="세탁실 상태를 불러오는 중입니다." />
                ) : (
                    <AsyncState
                        type="offline"
                        title="현재 오프라인 상태입니다."
                        description="저장된 세탁실 정보가 없어 인터넷 연결 후 다시 확인해야 합니다."
                        reason="네트워크 연결 끊김"
                    />
                )
            }
            regionLabel="세탁실 데이터"
            renderError={({retry}) =>
                isOnline ? (
                    <AsyncState
                        type="error"
                        title="세탁실 상태를 불러오지 못했습니다."
                        description="연결 상태를 확인한 뒤 다시 시도해 주세요."
                        retry={retry}
                        retryLabel="다시 시도"
                    />
                ) : (
                    <AsyncState
                        type="offline"
                        title="현재 오프라인 상태입니다."
                        description="인터넷 연결 후 세탁실 상태를 다시 확인해 주세요."
                        reason="네트워크 연결 끊김"
                    />
                )
            }
        >
            {children}
        </AsyncBoundary>
    );
}
