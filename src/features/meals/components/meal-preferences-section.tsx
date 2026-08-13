import {useEffect, useState} from 'react';
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {BellRing, CircleAlert, LoaderCircle, Smartphone} from 'lucide-react';
import {queryKeys, useDashboardEnvironment} from '@/app/dashboard-context';
import {ErrorState, LoadingState} from '@/components/dashboard/async-state';
import {Alert, AlertDescription, AlertTitle} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardDescription, CardHeader, CardTitle} from '@/components/ui/card';
import {Separator} from '@/components/ui/separator';
import {Switch} from '@/components/ui/switch';
import type {MealPreferences, MealPreferencesInput} from '@/api/dashboard-api';
import {accountAuthenticationRequired} from '@/api/account-authentication';

const asInput = (preferences: MealPreferences): MealPreferencesInput => ({
    enabled: preferences.enabled,
    lunch: preferences.lunch,
    dinner: preferences.dinner,
});

function preferencesEqual(left: MealPreferencesInput, right: MealPreferences): boolean {
    return left.enabled === right.enabled
        && left.lunch === right.lunch
        && left.dinner === right.dinner;
}

function PreferenceRow({
    checked,
    disabled,
    label,
    onCheckedChange,
}: {
    checked: boolean;
    disabled?: boolean;
    label: string;
    onCheckedChange: (checked: boolean) => void;
}) {
    return (
        <label className="flex cursor-pointer items-center justify-between gap-4 py-3">
            <span className="text-sm font-medium">{label}</span>
            <Switch
                aria-label={label}
                checked={checked}
                disabled={disabled}
                onCheckedChange={onCheckedChange}
            />
        </label>
    );
}

function MealPreferencesEditor({
    preferences,
    saved,
    saving,
    onEdit,
    onSave,
}: {
    preferences: MealPreferences;
    saved: boolean;
    saving: boolean;
    onEdit: () => void;
    onSave: (draft: MealPreferencesInput) => void;
}) {
    const [draft, setDraft] = useState<MealPreferencesInput>(() => asInput(preferences));
    const dirty = !preferencesEqual(draft, preferences);
    const updateDraft = (key: keyof MealPreferencesInput, checked: boolean) => {
        onEdit();
        setDraft((current) => ({...current, [key]: checked}));
    };

    return (
        <div className="mx-auto max-w-2xl">
            <PreferenceRow
                checked={draft.enabled}
                disabled={saving}
                label="급식 알림 사용"
                onCheckedChange={(checked) => updateDraft('enabled', checked)}
            />
            <Separator/>
            <div className="pl-4">
                <PreferenceRow
                    checked={draft.lunch}
                    disabled={!draft.enabled || saving}
                    label="중식"
                    onCheckedChange={(checked) => updateDraft('lunch', checked)}
                />
                <Separator/>
                <PreferenceRow
                    checked={draft.dinner}
                    disabled={!draft.enabled || saving}
                    label="석식"
                    onCheckedChange={(checked) => updateDraft('dinner', checked)}
                />
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-end gap-3 border-t pt-4">
                {saved ? <span className="text-xs text-primary">저장했습니다.</span> : null}
                <Button disabled={!dirty || saving} onClick={() => onSave(draft)}>
                    {saving ? <LoaderCircle className="animate-spin"/> : null}
                    설정 저장
                </Button>
            </div>
        </div>
    );
}

export function MealPreferencesSection() {
    const {api} = useDashboardEnvironment();
    const client = useQueryClient();
    const [saved, setSaved] = useState(false);
    const [editorRevision, setEditorRevision] = useState(0);
    const preferences = useQuery({
        queryKey: queryKeys.mealPreferences,
        queryFn: () => api.getMealPreferences(),
    });
    const savePreferences = useMutation({
        mutationFn: (input: MealPreferencesInput) => api.updateMealPreferences(input),
        onSuccess: async (value) => {
            client.setQueryData(queryKeys.mealPreferences, value);
            setEditorRevision((revision) => revision + 1);
            setSaved(true);
            await client.invalidateQueries({queryKey: queryKeys.mealPreferences});
        },
    });

    useEffect(() => {
        if (!saved) return;
        const timer = window.setTimeout(() => setSaved(false), 3_000);
        return () => window.clearTimeout(timer);
    }, [saved]);

    const error = preferences.error ?? savePreferences.error;
    const authRequired = accountAuthenticationRequired(error);
    if (authRequired) {
        return (
            <Alert>
                <Smartphone/>
                <AlertTitle>PC 연결이 필요합니다.</AlertTitle>
                <AlertDescription>
                    PC 앱 연결 후 급식 알림 설정 가능
                </AlertDescription>
            </Alert>
        );
    }

    return (
        <>
            <Card className="gap-4">
                <CardHeader>
                    <CardTitle className="flex items-center gap-2">
                        <BellRing className="size-4 text-primary"/>
                        급식 알림
                    </CardTitle>
                    <CardDescription>새 식단 게시물 중 선택한 식사 시간대만 알림</CardDescription>
                </CardHeader>
                <CardContent>
                    {preferences.isPending && !preferences.data ? (
                        <LoadingState label="급식 알림 설정 불러오는 중"/>
                    ) : preferences.isError && !preferences.data ? (
                        <ErrorState
                            description="PC 연결 상태를 확인하세요."
                            retry={() => void preferences.refetch()}
                        />
                    ) : preferences.data ? (
                        <MealPreferencesEditor
                            key={`${preferences.data.updatedAtEpochMs}:${editorRevision}`}
                            preferences={preferences.data}
                            saved={saved}
                            saving={savePreferences.isPending}
                            onEdit={() => setSaved(false)}
                            onSave={(draft) => savePreferences.mutate(draft)}
                        />
                    ) : null}
                </CardContent>
            </Card>

            {error ? (
                <Alert variant="destructive">
                    <CircleAlert/>
                    <AlertTitle>급식 알림 설정 저장 실패</AlertTitle>
                    <AlertDescription>연결 상태를 확인하고 새로고침하세요.</AlertDescription>
                </Alert>
            ) : null}
        </>
    );
}
