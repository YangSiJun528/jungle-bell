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
import {Switch} from '@/components/ui/switch';

import {attendancePreferencesEqual, attendanceSkipDate} from './attendance-view-model';

const MORNING_START_HOURS = [4, 5, 6, 7, 8, 9] as const;
const EVENING_END_HOURS = [0, 1, 2, 3, 4] as const;
const INTERVAL_MINUTES = [1, 3, 5, 10, 15, 30] as const;

function PreferenceSwitchRow({
    title,
    description,
    checked,
    disabled,
    onCheckedChange,
}: {
    title: string;
    description: string;
    checked: boolean;
    disabled: boolean;
    onCheckedChange: (checked: boolean) => void;
}) {
    return (
        <div className="flex items-center justify-between gap-4 py-4">
            <div className="min-w-0">
                <p className="text-sm font-medium">{title}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
            </div>
            <Switch
                aria-label={title}
                checked={checked}
                disabled={disabled}
                onCheckedChange={onCheckedChange}
            />
        </div>
    );
}

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
    const [draftOverride, setDraftOverride] = useState<AttendancePreferences | null>(null);
    const draft = draftOverride ?? preferences.data ?? null;

    const savePreferences = useMutation({
        mutationFn: (input: AttendancePreferences) => api.updateAttendancePreferences(input),
        onSuccess: (saved) => {
            client.setQueryData(queryKeys.attendancePreferences, saved);
            setDraftOverride(null);
        },
        onSettled: () => client.invalidateQueries({queryKey: queryKeys.attendancePreferences}),
    });
    const attendanceDate =
        attendance.data?.state === 'loaded' && attendance.data.attendance.status === 'available'
            ? attendance.data.attendance.snapshot.attendanceDate
            : null;
    const dirty = !attendancePreferencesEqual(draft, preferences.data ?? null);
    const authRequired = preferences.isError && accountAuthenticationRequired(preferences.error);
    const updateDraft = <Key extends keyof AttendancePreferences>(
        key: Key,
        value: AttendancePreferences[Key],
    ): void => {
        setDraftOverride((current) => {
            const base = current ?? preferences.data;
            return base ? {...base, [key]: value} : null;
        });
    };

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
                {preferences.isPending || (draft === null && !preferences.isError) ? (
                    <LoadingState label="출석 알림 설정을 불러오고 있습니다." />
                ) : authRequired ? (
                    <EmptyState
                        title="PC 연결이 필요합니다."
                        description="PC와 연결한 뒤 출석 알림을 설정할 수 있습니다."
                    />
                ) : preferences.isError || draft === null ? (
                    <ErrorState
                        title="출석 알림 설정을 불러오지 못했습니다."
                        retry={() => void preferences.refetch()}
                    />
                ) : (
                    <div>
                        <PreferenceSwitchRow
                            title="출석 알림 사용"
                            description="출석 알림 계획을 한 번에 켜거나 끕니다."
                            checked={draft.enabled}
                            disabled={savePreferences.isPending}
                            onCheckedChange={(enabled) => updateDraft('enabled', enabled)}
                        />
                        <Separator />
                        <div className="py-4">
                            <PreferenceSwitchRow
                                title="학습 시작 알림"
                                description="미완료 확인 시 선택한 간격으로, 상태 확인 불가 시 시작 시각·2시간 뒤·10시에 알립니다."
                                checked={draft.morning}
                                disabled={!draft.enabled || savePreferences.isPending}
                                onCheckedChange={(morning) => updateDraft('morning', morning)}
                            />
                            <div className="grid gap-4 sm:grid-cols-2">
                                <NumberSelect
                                    id="attendance-morning-start"
                                    label="학습 시작 확인 시각"
                                    value={draft.morningStartHour}
                                    options={MORNING_START_HOURS}
                                    disabled={
                                        !draft.enabled ||
                                        !draft.morning ||
                                        savePreferences.isPending
                                    }
                                    format={hourLabel}
                                    onValueChange={(value) =>
                                        updateDraft('morningStartHour', value)
                                    }
                                />
                                <NumberSelect
                                    id="attendance-morning-interval"
                                    label="학습 시작 미완료 알림 간격"
                                    value={draft.morningIntervalMinutes}
                                    options={INTERVAL_MINUTES}
                                    disabled={
                                        !draft.enabled ||
                                        !draft.morning ||
                                        savePreferences.isPending
                                    }
                                    format={(value) => `${value}분`}
                                    onValueChange={(value) =>
                                        updateDraft('morningIntervalMinutes', value)
                                    }
                                />
                            </div>
                        </div>
                        <Separator />
                        <div className="py-4">
                            <PreferenceSwitchRow
                                title="학습 종료 알림"
                                description="미완료 확인 시 선택한 간격으로, 상태 확인 불가 시 23시와 자정에만 알립니다."
                                checked={draft.evening}
                                disabled={!draft.enabled || savePreferences.isPending}
                                onCheckedChange={(evening) => updateDraft('evening', evening)}
                            />
                            <div className="grid gap-4 sm:grid-cols-2">
                                <NumberSelect
                                    id="attendance-evening-end"
                                    label="학습 종료 확인 종료 시각"
                                    value={draft.eveningEndHour}
                                    options={EVENING_END_HOURS}
                                    disabled={
                                        !draft.enabled ||
                                        !draft.evening ||
                                        savePreferences.isPending
                                    }
                                    format={hourLabel}
                                    onValueChange={(value) => updateDraft('eveningEndHour', value)}
                                />
                                <NumberSelect
                                    id="attendance-evening-interval"
                                    label="학습 종료 미완료 알림 간격"
                                    value={draft.eveningIntervalMinutes}
                                    options={INTERVAL_MINUTES}
                                    disabled={
                                        !draft.enabled ||
                                        !draft.evening ||
                                        savePreferences.isPending
                                    }
                                    format={(value) => `${value}분`}
                                    onValueChange={(value) =>
                                        updateDraft('eveningIntervalMinutes', value)
                                    }
                                />
                            </div>
                        </div>
                        <Separator />
                        <PreferenceSwitchRow
                            title="일요일 제외"
                            description="일요일에는 출석 알림을 계획하지 않습니다."
                            checked={draft.skipSunday}
                            disabled={!draft.enabled || savePreferences.isPending}
                            onCheckedChange={(skipSunday) => updateDraft('skipSunday', skipSunday)}
                        />
                        <Separator />
                        <PreferenceSwitchRow
                            title="이번 출석일 건너뛰기"
                            description={
                                attendanceDate
                                    ? `${attendanceDate} 하루만 알림을 쉽니다.`
                                    : '출석 기준일이 확인되면 선택할 수 있습니다.'
                            }
                            checked={
                                attendanceDate !== null &&
                                draft.skipAttendanceDate === attendanceDate
                            }
                            disabled={
                                !draft.enabled ||
                                savePreferences.isPending ||
                                attendanceDate === null
                            }
                            onCheckedChange={(checked) =>
                                updateDraft(
                                    'skipAttendanceDate',
                                    attendanceSkipDate(checked, attendanceDate),
                                )
                            }
                        />
                    </div>
                )}
            </CardContent>
            {draft ? (
                <CardFooter className="flex-wrap gap-3 border-t">
                    <Button
                        disabled={savePreferences.isPending || !dirty}
                        onClick={() => savePreferences.mutate(draft)}
                    >
                        {savePreferences.isPending ? '저장 중' : '출석 알림 저장'}
                    </Button>
                    {dirty ? (
                        <p className="text-xs text-amber-700 dark:text-amber-300">
                            저장하지 않은 변경이 있습니다.
                        </p>
                    ) : null}
                    {savePreferences.isSuccess && !dirty ? (
                        <p className="text-xs text-emerald-700 dark:text-emerald-300">
                            설정을 저장했습니다.
                        </p>
                    ) : null}
                    {savePreferences.isError ? (
                        <p className="text-xs text-destructive">설정을 저장하지 못했습니다.</p>
                    ) : null}
                </CardFooter>
            ) : null}
        </Card>
    );
}
