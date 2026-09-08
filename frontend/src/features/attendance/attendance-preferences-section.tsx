import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {BellRing} from 'lucide-react';
import {useState} from 'react';

import {accountAuthenticationRequired} from '@/api/account-authentication';
import type {AttendancePreferences} from '@/api/personal-api';
import {useDashboardAccount} from '@/app/dashboard-account';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {useAttendanceQuery} from '@/app/use-dashboard-queries';
import {EmptyState, ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {Button} from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import {Label} from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {Separator} from '@/components/ui/separator';
import {SwitchRow} from '@/components/ui/switch';

import {attendancePreferencesEqual, attendanceSkipDate} from './attendance-view-model';

const MORNING_START_HOURS = [4, 5, 6, 7, 8, 9] as const;
const EVENING_END_HOURS = [0, 1, 2, 3, 4] as const;
const INTERVAL_MINUTES = [1, 3, 5, 10, 15, 30] as const;

type UpdateDraft = <Key extends keyof AttendancePreferences>(
    key: Key,
    value: AttendancePreferences[Key],
) => void;

type PreferencesContentState =
    | {kind: 'loading'}
    | {kind: 'authentication-required'}
    | {kind: 'error'}
    | {kind: 'loaded'; draft: AttendancePreferences};

function NumberSelect<const Value extends number>({
    id,
    label,
    value,
    options,
    disabled,
    format,
    onValueChange,
}: {
    id: string;
    label: string;
    value: Value;
    options: readonly Value[];
    disabled: boolean;
    format: (value: Value) => string;
    onValueChange: (value: Value) => void;
}) {
    return (
        <div className="grid gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Select
                disabled={disabled}
                value={String(value)}
                onValueChange={(nextValue) => {
                    const next = options.find((option) => String(option) === nextValue);
                    if (next !== undefined) onValueChange(next);
                }}
            >
                <SelectTrigger id={id} aria-label={label} className="w-full">
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {options.map((option) => (
                        <SelectItem key={option} value={String(option)}>
                            {format(option)}
                        </SelectItem>
                    ))}
                </SelectContent>
            </Select>
        </div>
    );
}

function hourLabel(hour: number): string {
    if (hour === 0) return '자정';
    return `오전 ${hour}시`;
}

function updatedDraft<Key extends keyof AttendancePreferences>(
    current: AttendancePreferences | null,
    fallback: AttendancePreferences | undefined,
    key: Key,
    value: AttendancePreferences[Key],
): AttendancePreferences | null {
    const base = current ?? fallback;
    return base ? {...base, [key]: value} : null;
}

function useAttendancePreferencesDraft(saved: AttendancePreferences | undefined) {
    const [draftOverride, setDraftOverride] = useState<AttendancePreferences | null>(null);
    const updateDraft = <Key extends keyof AttendancePreferences>(
        key: Key,
        value: AttendancePreferences[Key],
    ): void => {
        setDraftOverride((current) => updatedDraft(current, saved, key, value));
    };

    return {
        draft: draftOverride ?? saved ?? null,
        resetDraft: () => setDraftOverride(null),
        updateDraft,
    };
}

function resolveContentState({
    draft,
    isPending,
    isError,
    authRequired,
}: {
    draft: AttendancePreferences | null;
    isPending: boolean;
    isError: boolean;
    authRequired: boolean;
}): PreferencesContentState {
    if (isPending || (draft === null && !isError)) return {kind: 'loading'};
    if (authRequired) return {kind: 'authentication-required'};
    if (isError || draft === null) return {kind: 'error'};
    return {kind: 'loaded', draft};
}

function resolveAttendanceDate(attendance: ReturnType<typeof useAttendanceQuery>): string | null {
    const data = attendance.data;
    if (data?.state !== 'loaded' || data.attendance.status !== 'available') return null;
    return data.attendance.snapshot.attendanceDate;
}

function resolveControls(
    draft: AttendancePreferences,
    attendanceDate: string | null,
    saving: boolean,
) {
    const dependentDisabled = !draft.enabled || saving;
    return {
        enabledDisabled: saving,
        morningDisabled: dependentDisabled,
        morningFieldsDisabled: dependentDisabled || !draft.morning,
        eveningDisabled: dependentDisabled,
        eveningFieldsDisabled: dependentDisabled || !draft.evening,
        skipSundayDisabled: dependentDisabled,
        skipAttendanceDateChecked:
            attendanceDate !== null && draft.skipAttendanceDate === attendanceDate,
        skipAttendanceDateDisabled: dependentDisabled || attendanceDate === null,
        skipAttendanceDateDescription: attendanceDate
            ? `${attendanceDate} 하루만 알림을 쉽니다.`
            : '출석 기준일이 확인되면 선택할 수 있습니다.',
    };
}

function AttendancePreferencesLoadedContent({
    draft,
    attendanceDate,
    saving,
    onUpdate,
}: {
    draft: AttendancePreferences;
    attendanceDate: string | null;
    saving: boolean;
    onUpdate: UpdateDraft;
}) {
    const controls = resolveControls(draft, attendanceDate, saving);

    return (
        <div>
            <SwitchRow
                label="출석 알림 사용"
                description="출석 알림 계획을 한 번에 켜거나 끕니다."
                checked={draft.enabled}
                disabled={controls.enabledDisabled}
                onCheckedChange={(enabled) => onUpdate('enabled', enabled)}
            />
            <Separator />
            <div className="py-4">
                <SwitchRow
                    label="학습 시작 알림"
                    description="미완료 확인 시 선택한 간격으로, 상태 확인 불가 시 시작 시각·2시간 뒤·10시에 알립니다."
                    checked={draft.morning}
                    disabled={controls.morningDisabled}
                    onCheckedChange={(morning) => onUpdate('morning', morning)}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                    <NumberSelect
                        id="attendance-morning-start"
                        label="학습 시작 확인 시각"
                        value={draft.morningStartHour}
                        options={MORNING_START_HOURS}
                        disabled={controls.morningFieldsDisabled}
                        format={hourLabel}
                        onValueChange={(value) => onUpdate('morningStartHour', value)}
                    />
                    <NumberSelect
                        id="attendance-morning-interval"
                        label="학습 시작 미완료 알림 간격"
                        value={draft.morningIntervalMinutes}
                        options={INTERVAL_MINUTES}
                        disabled={controls.morningFieldsDisabled}
                        format={(value) => `${value}분`}
                        onValueChange={(value) => onUpdate('morningIntervalMinutes', value)}
                    />
                </div>
            </div>
            <Separator />
            <div className="py-4">
                <SwitchRow
                    label="학습 종료 알림"
                    description="미완료 확인 시 선택한 간격으로, 상태 확인 불가 시 23시와 자정에만 알립니다."
                    checked={draft.evening}
                    disabled={controls.eveningDisabled}
                    onCheckedChange={(evening) => onUpdate('evening', evening)}
                />
                <div className="grid gap-4 sm:grid-cols-2">
                    <NumberSelect
                        id="attendance-evening-end"
                        label="학습 종료 확인 종료 시각"
                        value={draft.eveningEndHour}
                        options={EVENING_END_HOURS}
                        disabled={controls.eveningFieldsDisabled}
                        format={hourLabel}
                        onValueChange={(value) => onUpdate('eveningEndHour', value)}
                    />
                    <NumberSelect
                        id="attendance-evening-interval"
                        label="학습 종료 미완료 알림 간격"
                        value={draft.eveningIntervalMinutes}
                        options={INTERVAL_MINUTES}
                        disabled={controls.eveningFieldsDisabled}
                        format={(value) => `${value}분`}
                        onValueChange={(value) => onUpdate('eveningIntervalMinutes', value)}
                    />
                </div>
            </div>
            <Separator />
            <SwitchRow
                label="일요일 제외"
                description="일요일에는 출석 알림을 계획하지 않습니다."
                checked={draft.skipSunday}
                disabled={controls.skipSundayDisabled}
                onCheckedChange={(skipSunday) => onUpdate('skipSunday', skipSunday)}
            />
            <Separator />
            <SwitchRow
                label="이번 출석일 건너뛰기"
                description={controls.skipAttendanceDateDescription}
                checked={controls.skipAttendanceDateChecked}
                disabled={controls.skipAttendanceDateDisabled}
                onCheckedChange={(checked) =>
                    onUpdate('skipAttendanceDate', attendanceSkipDate(checked, attendanceDate))
                }
            />
        </div>
    );
}

function AttendancePreferencesContent({
    state,
    attendanceDate,
    saving,
    onUpdate,
    onRetry,
}: {
    state: PreferencesContentState;
    attendanceDate: string | null;
    saving: boolean;
    onUpdate: UpdateDraft;
    onRetry: () => void;
}) {
    if (state.kind === 'loading') {
        return <LoadingState label="출석 알림 설정을 불러오고 있습니다." />;
    }
    if (state.kind === 'authentication-required') {
        return (
            <EmptyState
                title="PC 연결이 필요합니다."
                description="PC와 연결한 뒤 출석 알림을 설정할 수 있습니다."
            />
        );
    }
    if (state.kind === 'error') {
        return <ErrorState title="출석 알림 설정을 불러오지 못했습니다." retry={onRetry} />;
    }
    return (
        <AttendancePreferencesLoadedContent
            draft={state.draft}
            attendanceDate={attendanceDate}
            saving={saving}
            onUpdate={onUpdate}
        />
    );
}

function AttendancePreferencesSaveStatus({
    dirty,
    saved,
    failed,
}: {
    dirty: boolean;
    saved: boolean;
    failed: boolean;
}) {
    return (
        <>
            {dirty ? (
                <p className="text-xs text-amber-700 dark:text-amber-300">
                    저장하지 않은 변경이 있습니다.
                </p>
            ) : null}
            {saved && !dirty ? (
                <p className="text-xs text-emerald-700 dark:text-emerald-300">
                    설정을 저장했습니다.
                </p>
            ) : null}
            {failed ? (
                <p className="text-xs text-destructive">설정을 저장하지 못했습니다.</p>
            ) : null}
        </>
    );
}

function AttendancePreferencesFooter({
    draft,
    dirty,
    saving,
    saved,
    failed,
    onSave,
}: {
    draft: AttendancePreferences | null;
    dirty: boolean;
    saving: boolean;
    saved: boolean;
    failed: boolean;
    onSave: (draft: AttendancePreferences) => void;
}) {
    if (draft === null) return null;

    return (
        <CardFooter className="flex-wrap gap-3 border-t">
            <Button disabled={saving || !dirty} onClick={() => onSave(draft)}>
                {saving ? '저장 중' : '출석 알림 저장'}
            </Button>
            <AttendancePreferencesSaveStatus dirty={dirty} saved={saved} failed={failed} />
        </CardFooter>
    );
}

export function AttendancePreferencesSection() {
    const {api} = useDashboardEnvironment();
    const account = useDashboardAccount();
    const client = useQueryClient();
    const attendance = useAttendanceQuery();
    const preferences = useQuery({
        queryKey: queryKeys.attendancePreferences,
        queryFn: () => api.getAttendancePreferences(),
        enabled: account.personalAccess.status === 'connected',
    });
    const {draft, resetDraft, updateDraft} = useAttendancePreferencesDraft(preferences.data);
    const savePreferences = useMutation({
        mutationFn: (input: AttendancePreferences) => api.updateAttendancePreferences(input),
        onSuccess: (saved) => {
            client.setQueryData(queryKeys.attendancePreferences, saved);
            resetDraft();
        },
        onSettled: () => client.invalidateQueries({queryKey: queryKeys.attendancePreferences}),
    });
    const attendanceDate = resolveAttendanceDate(attendance);
    const dirty = !attendancePreferencesEqual(draft, preferences.data ?? null);
    const authRequired = preferences.isError && accountAuthenticationRequired(preferences.error);
    const contentState = resolveContentState({
        draft,
        isPending: preferences.isPending,
        isError: preferences.isError,
        authRequired,
    });

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    <BellRing className="size-4 text-primary" />
                    출석 알림 설정
                </CardTitle>
                <CardDescription>
                    PC에서 미완료가 확인되면 설정 간격으로, 상태를 확인할 수 없으면 제한된 시각에
                    알립니다.
                </CardDescription>
            </CardHeader>
            <CardContent>
                <AttendancePreferencesContent
                    state={contentState}
                    attendanceDate={attendanceDate}
                    saving={savePreferences.isPending}
                    onUpdate={updateDraft}
                    onRetry={() => void preferences.refetch()}
                />
            </CardContent>
            <AttendancePreferencesFooter
                draft={draft}
                dirty={dirty}
                saving={savePreferences.isPending}
                saved={savePreferences.isSuccess}
                failed={savePreferences.isError}
                onSave={(value) => savePreferences.mutate(value)}
            />
        </Card>
    );
}
