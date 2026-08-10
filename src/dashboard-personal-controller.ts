import {companionAuthenticationRequired} from './dashboard-model';
import type {DashboardPersonalApi, PersonalSurface} from './dashboard-personal-api';
import {
    applianceLabel,
    hasDuplicateActiveWatch,
    hasWaitingQueue,
    laundryTargets,
    machineLabel,
    queueStatusLabel,
    watchConditionLabel,
    type LaundryTarget,
} from './dashboard-personal-state';

export function createDashboardPersonalActions(api: DashboardPersonalApi): Record<string, unknown> {
    return {
        async loadPersonalControls(this: any, manual = false) {
            const surface = personalSurface(this.surface.kind);
            if (surface === null) {
                this.personalControlsState = 'auth-required';
                return;
            }
            if (this.personalControlsState !== 'loaded') this.personalControlsState = 'loading';
            if (manual) this.personalControlsMessage = '';
            try {
                const [attendance, meals, watches, queue] = await Promise.all([
                    api.getAttendancePreferences(surface),
                    api.getMealPreferences(surface),
                    api.listLaundryWatches(surface),
                    api.listLaundryQueue(surface),
                ]);
                if (!this.attendancePreferencesDirty) {
                    this.attendancePreferences = attendance;
                    this.attendancePreferencesDirty = false;
                }
                if (!this.mealPreferencesDirty) {
                    this.mealPreferences = meals;
                    this.mealPreferencesDirty = false;
                }
                this.laundryWatches = watches;
                this.laundryQueue = queue;
                this.laundryPersonalUpdatedAtEpochMs = Date.now();
                this.personalControlsState = 'loaded';
                this.ensureLaundryTargetSelection();
                if (manual) this.personalControlsMessage = '개인 알림 설정을 새로 확인했어요.';
            } catch (error) {
                if (surface === 'companion' && companionAuthenticationRequired(error)) {
                    this.personalControlsState = 'auth-required';
                    this.attendancePreferences = null;
                    this.mealPreferences = null;
                    this.laundryWatches = [];
                    this.laundryQueue = [];
                    return;
                }
                console.error('[dashboard] personal controls load failed', error);
                if (this.personalControlsState !== 'loaded') this.personalControlsState = 'error';
                if (manual) this.personalControlsMessage = '개인 알림 설정을 새로 확인하지 못했어요.';
            }
        },

        async refreshLaundryPersonalControls(this: any, manual = false) {
            const surface = personalSurface(this.surface.kind);
            if (surface === null || this.laundryPersonalBusy) return;
            this.laundryPersonalBusy = true;
            if (manual) this.personalControlsMessage = '';
            try {
                const [watches, queue] = await Promise.all([
                    api.listLaundryWatches(surface),
                    api.listLaundryQueue(surface),
                ]);
                this.laundryWatches = watches;
                this.laundryQueue = queue;
                this.laundryPersonalUpdatedAtEpochMs = Date.now();
                if (manual) this.personalControlsMessage = '세탁 알림과 자율 대기열을 새로 확인했어요.';
            } catch (error) {
                if (surface === 'companion' && companionAuthenticationRequired(error)) {
                    this.personalControlsState = 'auth-required';
                    return;
                }
                console.error('[dashboard] laundry personal controls refresh failed', error);
                if (manual) this.personalControlsMessage = '세탁 알림과 자율 대기열을 새로 확인하지 못했어요.';
            } finally {
                this.laundryPersonalBusy = false;
            }
        },

        setAttendancePreference(this: any, key: 'morning' | 'evening' | 'skipSunday', checked: boolean) {
            if (!this.attendancePreferences || typeof checked !== 'boolean') return;
            this.attendancePreferences = {...this.attendancePreferences, [key]: checked};
            this.attendancePreferencesDirty = true;
        },

        setSkipAttendanceDate(this: any, checked: boolean) {
            if (!this.attendancePreferences || typeof checked !== 'boolean') return;
            const attendanceDate = this.attendanceSnapshot?.attendanceDate as string | undefined;
            if (checked && !attendanceDate) return;
            this.attendancePreferences = {
                ...this.attendancePreferences,
                skipAttendanceDate: checked ? attendanceDate : null,
            };
            this.attendancePreferencesDirty = true;
        },

        async saveAttendancePreferences(this: any) {
            const surface = personalSurface(this.surface.kind);
            if (surface === null || !this.attendancePreferences || this.attendancePreferencesBusy) return;
            this.attendancePreferencesBusy = true;
            this.personalControlsMessage = '';
            const input = {...this.attendancePreferences};
            try {
                const saved = await api.updateAttendancePreferences(surface, input);
                if (sameAttendancePreferences(this.attendancePreferences, input)) {
                    this.attendancePreferences = saved;
                    this.attendancePreferencesDirty = false;
                }
                this.personalControlsMessage = '출석 알림 설정을 저장했어요.';
            } catch (error) {
                console.error('[dashboard] attendance preferences save failed', error);
                this.personalControlsMessage = '출석 알림 설정을 저장하지 못했어요.';
            } finally {
                this.attendancePreferencesBusy = false;
            }
        },

        setMealPreference(this: any, key: 'enabled' | 'breakfast' | 'lunch' | 'dinner', checked: boolean) {
            if (!this.mealPreferences || typeof checked !== 'boolean') return;
            this.mealPreferences = {...this.mealPreferences, [key]: checked};
            this.mealPreferencesDirty = true;
        },

        async saveMealPreferences(this: any) {
            const surface = personalSurface(this.surface.kind);
            if (surface === null || !this.mealPreferences || this.mealPreferencesBusy) return;
            this.mealPreferencesBusy = true;
            this.personalControlsMessage = '';
            const input = {
                enabled: this.mealPreferences.enabled,
                breakfast: this.mealPreferences.breakfast,
                lunch: this.mealPreferences.lunch,
                dinner: this.mealPreferences.dinner,
            };
            try {
                const saved = await api.updateMealPreferences(surface, input);
                if (sameMealPreferences(this.mealPreferences, input)) {
                    this.mealPreferences = saved;
                    this.mealPreferencesDirty = false;
                }
                this.personalControlsMessage = '급식 알림 설정을 저장했어요.';
            } catch (error) {
                console.error('[dashboard] meal preferences save failed', error);
                this.personalControlsMessage = '급식 알림 설정을 저장하지 못했어요.';
            } finally {
                this.mealPreferencesBusy = false;
            }
        },

        personalLaundryTargets(this: any): LaundryTarget[] {
            return laundryTargets(this.laundryMachines);
        },

        ensureLaundryTargetSelection(this: any) {
            const targets = laundryTargets(this.laundryMachines);
            if (!targets.some((target) => target.key === this.selectedLaundryTargetKey)) {
                this.selectedLaundryTargetKey = targets[0]?.key ?? '';
            }
        },

        selectedLaundryTarget(this: any): LaundryTarget | null {
            const targets = laundryTargets(this.laundryMachines);
            return targets.find((target) => target.key === this.selectedLaundryTargetKey) ?? targets[0] ?? null;
        },

        selectedLaundryTargetHasWatch(this: any): boolean {
            const target = this.selectedLaundryTarget();
            return target ? hasDuplicateActiveWatch(this.laundryWatches, target) : false;
        },

        async addLaundryWatch(this: any) {
            const surface = personalSurface(this.surface.kind);
            const target = this.selectedLaundryTarget();
            if (surface === null || !target || this.laundryPersonalBusy) return;
            if (hasDuplicateActiveWatch(this.laundryWatches, target)) {
                this.personalControlsMessage = '같은 조건의 세탁 알림이 이미 있어요.';
                return;
            }
            this.laundryPersonalBusy = true;
            this.personalControlsMessage = '';
            try {
                const created = await api.createLaundryWatch(surface, {
                    machineId: target.machineId,
                    appliance: target.appliance,
                    sessionId: target.sessionId,
                    notifyBeforeMinutes: target.sessionId === null ? 0 : 10,
                    notifyWhenAvailable: true,
                });
                this.laundryWatches = [created, ...this.laundryWatches.filter((watch: any) => watch.id !== created.id)];
                this.laundryPersonalUpdatedAtEpochMs = Date.now();
                this.personalControlsMessage = '세탁 알림을 추가했어요.';
            } catch (error) {
                console.error('[dashboard] laundry watch create failed', error);
                this.personalControlsMessage = '세탁 알림을 추가하지 못했어요.';
            } finally {
                this.laundryPersonalBusy = false;
            }
        },

        async cancelLaundryWatch(this: any, id: string) {
            const surface = personalSurface(this.surface.kind);
            if (surface === null || this.laundryPersonalBusy) return;
            this.laundryPersonalBusy = true;
            this.personalControlsMessage = '';
            try {
                await api.deleteLaundryWatch(surface, id);
                this.laundryWatches = this.laundryWatches.filter((watch: any) => watch.id !== id);
                this.laundryPersonalUpdatedAtEpochMs = Date.now();
                this.personalControlsMessage = '세탁 알림을 취소했어요.';
            } catch (error) {
                console.error('[dashboard] laundry watch delete failed', error);
                this.personalControlsMessage = '세탁 알림을 취소하지 못했어요.';
            } finally {
                this.laundryPersonalBusy = false;
            }
        },

        async joinLaundryQueue(this: any, appliance: 'washer' | 'dryer') {
            const surface = personalSurface(this.surface.kind);
            if (surface === null || this.laundryPersonalBusy || hasWaitingQueue(this.laundryQueue, appliance)) return;
            this.laundryPersonalBusy = true;
            this.personalControlsMessage = '';
            try {
                const created = await api.joinLaundryQueue(surface, {machineId: null, appliance});
                this.laundryQueue = [created, ...this.laundryQueue.filter((entry: any) => entry.id !== created.id)];
                this.laundryPersonalUpdatedAtEpochMs = Date.now();
                this.personalControlsMessage = `${applianceLabel(appliance)} 자율 대기열에 참여했어요.`;
            } catch (error) {
                console.error('[dashboard] laundry queue join failed', error);
                this.personalControlsMessage = '자율 대기열에 참여하지 못했어요.';
            } finally {
                this.laundryPersonalBusy = false;
            }
        },

        async leaveLaundryQueue(this: any, id: string) {
            const surface = personalSurface(this.surface.kind);
            if (surface === null || this.laundryPersonalBusy) return;
            this.laundryPersonalBusy = true;
            this.personalControlsMessage = '';
            try {
                await api.leaveLaundryQueue(surface, id);
                this.laundryQueue = this.laundryQueue.filter((entry: any) => entry.id !== id);
                this.laundryPersonalUpdatedAtEpochMs = Date.now();
                this.personalControlsMessage = '자율 대기열 참여를 취소했어요.';
            } catch (error) {
                console.error('[dashboard] laundry queue leave failed', error);
                this.personalControlsMessage = '자율 대기열 참여를 취소하지 못했어요.';
            } finally {
                this.laundryPersonalBusy = false;
            }
        },

        waitingLaundryQueue(this: any, appliance: 'washer' | 'dryer'): boolean {
            return hasWaitingQueue(this.laundryQueue, appliance);
        },

        activeLaundryWatches(this: any) {
            return this.laundryWatches.filter((watch: any) => watch.status === 'active');
        },

        visibleLaundryQueue(this: any) {
            return this.laundryQueue.filter((entry: any) => entry.status !== 'cancelled');
        },

        personalWatchLabel(_this: any, watch?: Parameters<typeof watchConditionLabel>[0]): string {
            const value = typeof _this?.machineId === 'string' ? _this : watch;
            return value
                ? `${machineLabel(value.machineId)} · ${applianceLabel(value.appliance)} · ${watchConditionLabel(value)}`
                : '';
        },

        personalQueueLabel(_this: any, entry?: Parameters<typeof queueStatusLabel>[0]): string {
            const value = typeof _this?.appliance === 'string' ? _this : entry;
            return value ? `${applianceLabel(value.appliance)} · ${queueStatusLabel(value)}` : '';
        },
    };
}

function personalSurface(kind: unknown): PersonalSurface | null {
    return kind === 'desktop' || kind === 'companion' ? kind : null;
}

function sameAttendancePreferences(left: any, right: any): boolean {
    return left?.morning === right.morning
        && left?.evening === right.evening
        && left?.skipSunday === right.skipSunday
        && left?.skipAttendanceDate === right.skipAttendanceDate;
}

function sameMealPreferences(left: any, right: any): boolean {
    return left?.enabled === right.enabled
        && left?.breakfast === right.breakfast
        && left?.lunch === right.lunch
        && left?.dinner === right.dinner;
}
