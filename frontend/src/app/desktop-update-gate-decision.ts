import type {DesktopUpdateStatus} from '@/platform/contracts';

interface DesktopUpdateGateDecisionInput {
    desktop: boolean;
    data: DesktopUpdateStatus | undefined;
    queryPending: boolean;
    queryError: boolean;
}

export interface DesktopUpdateGateDecision {
    renderDashboard: boolean;
    blocked: boolean;
    canAdmit: boolean;
}

export function desktopUpdateGateDecision({
    desktop,
    data,
}: DesktopUpdateGateDecisionInput): DesktopUpdateGateDecision {
    if (!desktop) return {renderDashboard: true, blocked: false, canAdmit: true};
    const mandatory = data?.policy === 'mandatory';
    const canAdmit = data?.status === 'latest' || data?.policy === 'optional';
    return {
        renderDashboard: true,
        blocked: mandatory || !canAdmit,
        canAdmit,
    };
}
