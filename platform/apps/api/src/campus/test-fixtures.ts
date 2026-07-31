export function laundryFixture() {
  return {
    schemaVersion: 1,
    sourceVersionSha: "source-sha",
    asOf: "2026-07-31T00:00:00.000Z",
    final: false,
    quality: {
      collection: "SUCCESS",
      sourceFreshness: "REFRESH_OBSERVED",
      certainty: "OBSERVED_API_VALUE",
      basis: "HASH_CADENCE",
      lastCheckedAt: "2026-07-31T00:00:00.000Z",
      expectedRefreshIntervalSeconds: 60,
    },
    machines: [],
    events: [],
    unknownEnums: [],
  } as const;
}
export function mealsFixture() {
  return {
    asOf: "2026-07-31T00:00:00.000Z",
    lastCheckedAt: "2026-07-31T00:00:00.000Z",
    data: {
      schemaVersion: 2,
      sourceVersionSha: "meal-sha",
      observedAt: "2026-07-31T00:00:00.000Z",
      hasNext: false,
      pinnedMenus: [],
      dailyMenus: [],
      otherPosts: [],
      currentWeeklyMenu: {
        targetWeekKey: "2026-07-27",
        status: "AWAITING_UPDATE",
        contentSha: null,
        post: null,
      },
      recentMenus: [],
      weeklyMenus: [],
      historyNextBefore: null,
    },
  } as const;
}
