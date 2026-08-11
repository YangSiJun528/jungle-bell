export interface DashboardRefreshTasks {
    refreshLaundry(): Promise<unknown>;
    refreshMeals(): Promise<unknown>;
    refreshPlatform?(): Promise<unknown>;
    refreshAttendance?(): Promise<unknown>;
    refreshHomeOverview?(): Promise<unknown>;
}

export interface AttendanceRefreshTasks {
    refreshPlatform?(): Promise<unknown>;
    refreshAttendance(): Promise<unknown>;
    refreshHomeOverview?(): Promise<unknown>;
}

export async function runAttendanceRefresh(tasks: AttendanceRefreshTasks): Promise<void> {
    await tasks.refreshPlatform?.();
    await Promise.all([
        tasks.refreshAttendance(),
        tasks.refreshHomeOverview?.(),
    ]);
}

export async function runDashboardRefresh(tasks: DashboardRefreshTasks): Promise<void> {
    const campusRefresh = Promise.all([
        tasks.refreshLaundry(),
        tasks.refreshMeals(),
    ]);
    const platformRefresh = tasks.refreshPlatform?.();
    const personalRefresh = (async () => {
        if (platformRefresh) await platformRefresh;
        await Promise.all([
            tasks.refreshAttendance?.(),
            tasks.refreshHomeOverview?.(),
        ]);
    })();

    await Promise.all([campusRefresh, personalRefresh]);
}
