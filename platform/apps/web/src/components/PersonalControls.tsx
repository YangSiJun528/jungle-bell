import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  getPublicLaundry,
  type LaundryAppliance,
} from "../campus-client";
import { hasActiveLaundrySession } from "../laundry-state";
import {
  cancelLaundryWatch,
  createLaundryWatch,
  getAttendanceRule,
  getLaundryQueue,
  getLaundryWatches,
  getMealRule,
  joinLaundryQueue,
  leaveLaundryQueue,
  putAttendanceRule,
  putMealRule,
  type AttendanceRuleDto,
  type AttendanceRuleInput,
  type ApplianceKind,
  type LaundryQueueEntryDto,
  type LaundryWatchDto,
  type MealRuleDto,
  type MealRuleInput,
} from "../personal-client";
import { SelectControl, SettingSwitch } from "./ui";

const LAUNDRY_REFRESH_INTERVAL_MS = 45_000;

interface LaundryTarget {
  readonly key: string;
  readonly machineId: string;
  readonly appliance: ApplianceKind;
  readonly sessionId: string | null;
  readonly label: string;
}

interface LoadedView {
  readonly state: "loaded";
  readonly mealRule: MealRuleDto;
  readonly mealDirty: boolean;
  readonly attendanceRule: AttendanceRuleDto;
  readonly attendanceDirty: boolean;
  readonly watches: readonly LaundryWatchDto[];
  readonly queue: readonly LaundryQueueEntryDto[];
  readonly targets: readonly LaundryTarget[];
  readonly laundryUpdatedAtEpochMs: number;
}

type ViewState =
  | { readonly state: "loading" }
  | { readonly state: "error" }
  | LoadedView;

interface BusyState {
  readonly meal: boolean;
  readonly attendance: boolean;
  readonly laundry: boolean;
  readonly queue: boolean;
  readonly refresh: boolean;
}

const initialBusy: BusyState = {
  meal: false,
  attendance: false,
  laundry: false,
  queue: false,
  refresh: false,
};

const mealLabels = {
  breakfast: "아침",
  lunch: "점심",
  dinner: "저녁",
} as const;

export function PersonalControls() {
  const [view, setView] = useState<ViewState>({ state: "loading" });
  const [selectedTargetKey, setSelectedTargetKey] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<BusyState>(initialBusy);
  const mountedRef = useRef(true);
  const watchMutationVersionRef = useRef(0);
  const queueMutationVersionRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    void Promise.all([
      getAttendanceRule(),
      getMealRule(),
      getLaundryWatches(),
      getLaundryQueue(),
      getPublicLaundry().catch(() => null),
    ])
      .then(([attendanceRule, mealRule, watches, queue, laundry]) => {
        if (!mountedRef.current) {
          return;
        }
        const targets = laundry?.data
          ? laundryTargets(laundry.data.machines)
          : [];
        setView({
          state: "loaded",
          attendanceRule,
          attendanceDirty: false,
          mealRule,
          mealDirty: false,
          watches,
          queue,
          targets,
          laundryUpdatedAtEpochMs: Date.now(),
        });
        setSelectedTargetKey((current) =>
          selectAvailableTarget(current, targets),
        );
      })
      .catch(() => {
        if (mountedRef.current) {
          setView({ state: "error" });
        }
      });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshLaundryState = useCallback(async (manual: boolean) => {
    const watchVersion = watchMutationVersionRef.current;
    const queueVersion = queueMutationVersionRef.current;
    if (manual) {
      setBusy((current) => ({ ...current, refresh: true }));
      setMessage("");
    }
    try {
      const [watches, queue, laundry] = await Promise.all([
        getLaundryWatches(),
        getLaundryQueue(),
        getPublicLaundry().catch(() => null),
      ]);
      if (!mountedRef.current) {
        return;
      }
      const targets = laundry?.data
        ? laundryTargets(laundry.data.machines)
        : null;
      setView((current) =>
        updateLoaded(current, (loaded) => ({
          ...loaded,
          watches:
            watchVersion === watchMutationVersionRef.current
              ? watches
              : loaded.watches,
          queue:
            queueVersion === queueMutationVersionRef.current
              ? queue
              : loaded.queue,
          targets: targets ?? loaded.targets,
          laundryUpdatedAtEpochMs: Date.now(),
        })),
      );
      if (targets !== null) {
        setSelectedTargetKey((current) =>
          selectAvailableTarget(current, targets),
        );
      }
      if (manual) {
        setMessage("세탁 알림과 자율 대기열을 새로 확인했어요.");
      }
    } catch {
      if (manual && mountedRef.current) {
        setMessage("세탁 알림과 자율 대기열을 새로 확인하지 못했어요.");
      }
    } finally {
      if (manual && mountedRef.current) {
        setBusy((current) => ({ ...current, refresh: false }));
      }
    }
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshLaundryState(false);
    }, LAUNDRY_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshLaundryState]);

  if (view.state === "loading") {
    return (
      <section className="card settings-card" aria-busy="true">
        <div className="eyebrow">알림</div>
        <h2>알림 설정</h2>
        <p className="ui-empty-state">알림 설정을 불러오고 있어요.</p>
      </section>
    );
  }
  if (view.state === "error") {
    return (
      <section className="card settings-card">
        <div className="eyebrow">알림</div>
        <h2>알림 설정</h2>
        <p className="error-notice">
          알림 설정을 불러오지 못했어요.
        </p>
      </section>
    );
  }

  const updateMeal = (
    meal: keyof Pick<
      MealRuleDto,
      "breakfast" | "lunch" | "dinner"
    >,
  ) => {
    setView((current) =>
      updateLoaded(current, (loaded) => ({
        ...loaded,
        mealRule: {
          ...loaded.mealRule,
          [meal]: !loaded.mealRule[meal],
        },
        mealDirty: true,
      })),
    );
  };

  const saveMealRule = async () => {
    const input = mealRuleInput(view.mealRule);
    setBusy((current) => ({ ...current, meal: true }));
    setMessage("");
    try {
      const saved = await putMealRule(input);
      setView((current) =>
        updateLoaded(current, (loaded) =>
          sameMealRule(loaded.mealRule, input)
            ? { ...loaded, mealRule: saved, mealDirty: false }
            : loaded,
        ),
      );
      setMessage("급식 알림 설정을 저장했어요.");
    } catch {
      setMessage("급식 알림 설정을 저장하지 못했어요.");
    } finally {
      setBusy((current) => ({ ...current, meal: false }));
    }
  };

  const saveAttendanceRule = async () => {
    const input = attendanceRuleInput(view.attendanceRule);
    setBusy((current) => ({ ...current, attendance: true }));
    setMessage("");
    try {
      const saved = await putAttendanceRule(input);
      setView((current) =>
        updateLoaded(current, (loaded) =>
          sameAttendanceRule(loaded.attendanceRule, input)
            ? {
                ...loaded,
                attendanceRule: saved,
                attendanceDirty: false,
              }
            : loaded,
        ),
      );
      setMessage("출석 알림 설정을 저장했어요.");
    } catch {
      setMessage("출석 알림 설정을 저장하지 못했어요.");
    } finally {
      setBusy((current) => ({ ...current, attendance: false }));
    }
  };

  const selectedTarget = view.targets.find(
    ({ key }) => key === selectedTargetKey,
  );
  const duplicateSelectedWatch =
    selectedTarget !== undefined &&
    hasDuplicateActiveWatch(view.watches, selectedTarget);

  const addWatch = async () => {
    const target = selectedTarget;
    if (!target) {
      setMessage("알림을 받을 세탁 기기를 선택해 주세요.");
      return;
    }
    if (hasDuplicateActiveWatch(view.watches, target)) {
      setMessage("같은 조건의 세탁 알림이 이미 등록되어 있어요.");
      return;
    }
    watchMutationVersionRef.current += 1;
    setBusy((current) => ({ ...current, laundry: true }));
    setMessage("");
    try {
      const created = await createLaundryWatch({
        machineId: target.machineId,
        appliance: target.appliance,
        sessionId: target.sessionId,
        notifyBeforeMinutes: target.sessionId === null ? 0 : 10,
        notifyWhenAvailable: true,
      });
      setView((current) =>
        updateLoaded(current, (loaded) => ({
          ...loaded,
          watches: upsertWatch(loaded.watches, created),
          laundryUpdatedAtEpochMs: Date.now(),
        })),
      );
      setMessage("세탁 알림을 추가했어요.");
    } catch {
      setMessage("세탁 알림을 추가하지 못했어요.");
    } finally {
      setBusy((current) => ({ ...current, laundry: false }));
    }
  };

  const cancelWatch = async (id: string) => {
    watchMutationVersionRef.current += 1;
    setBusy((current) => ({ ...current, laundry: true }));
    setMessage("");
    try {
      await cancelLaundryWatch(id);
      setView((current) =>
        updateLoaded(current, (loaded) => ({
          ...loaded,
          watches: loaded.watches.filter((watch) => watch.id !== id),
          laundryUpdatedAtEpochMs: Date.now(),
        })),
      );
      setMessage("세탁 알림을 취소했어요.");
    } catch {
      setMessage("세탁 알림을 취소하지 못했어요.");
    } finally {
      setBusy((current) => ({ ...current, laundry: false }));
    }
  };

  const joinQueue = async (appliance: ApplianceKind) => {
    if (hasWaitingQueue(view.queue, appliance)) {
      setMessage("이미 해당 자율 대기열에 참여하고 있어요.");
      return;
    }
    queueMutationVersionRef.current += 1;
    setBusy((current) => ({ ...current, queue: true }));
    setMessage("");
    try {
      const entry = await joinLaundryQueue({
        machineId: null,
        appliance,
      });
      setView((current) =>
        updateLoaded(current, (loaded) => ({
          ...loaded,
          queue: upsertQueueEntry(loaded.queue, entry),
          laundryUpdatedAtEpochMs: Date.now(),
        })),
      );
      setMessage("자율 대기열에 참여했어요.");
    } catch {
      setMessage("대기열에 참여하지 못했어요.");
    } finally {
      setBusy((current) => ({ ...current, queue: false }));
    }
  };

  const leaveQueue = async (id: string) => {
    queueMutationVersionRef.current += 1;
    setBusy((current) => ({ ...current, queue: true }));
    setMessage("");
    try {
      await leaveLaundryQueue(id);
      setView((current) =>
        updateLoaded(current, (loaded) => ({
          ...loaded,
          queue: loaded.queue.filter((entry) => entry.id !== id),
          laundryUpdatedAtEpochMs: Date.now(),
        })),
      );
      setMessage("대기 참여를 취소했어요.");
    } catch {
      setMessage("대기 참여를 취소하지 못했어요.");
    } finally {
      setBusy((current) => ({ ...current, queue: false }));
    }
  };

  const laundryDisabled = busy.laundry || busy.refresh;
  const queueDisabled = busy.queue || busy.refresh;

  return (
    <section className="card settings-card">
      <div className="section-heading">
        <div>
          <div className="eyebrow">연결된 기기에서 함께 사용</div>
          <h2>알림 설정</h2>
        </div>
        <SettingSwitch
          ariaLabel="급식 알림 전체"
          checked={view.mealRule.enabled}
          compact
          disabled={busy.meal}
          label="급식 알림"
          onChange={(checked) =>
            setView((current) =>
              updateLoaded(current, (loaded) => ({
                ...loaded,
                mealRule: {
                  ...loaded.mealRule,
                  enabled: checked,
                },
                mealDirty: true,
              })),
            )
          }
        />
      </div>

      <div className="button-row">
        <p className="metadata">
          세탁·대기열 최근 갱신{" "}
          <time dateTime={new Date(view.laundryUpdatedAtEpochMs).toISOString()}>
            {formatUpdatedTime(view.laundryUpdatedAtEpochMs)}
          </time>
        </p>
        <button
          className="compact-button"
          type="button"
          disabled={
            busy.refresh || busy.laundry || busy.queue
          }
          onClick={() => void refreshLaundryState(true)}
        >
          {busy.refresh ? "새로고침 중" : "세탁·대기열 새로고침"}
        </button>
      </div>

      <div className="personal-controls-grid">
        <fieldset className="settings-group" aria-busy={busy.attendance}>
          <legend>출석 알림</legend>
          <p>
            PC가 동기화한 최신 출석 상태를 기준으로 마감 전 지정 시점과
            마감 후 한 번 알려드려요. 처음에는 꺼져 있어요.
          </p>
          <SettingSwitch
            ariaLabel="출석 알림 전체"
            checked={view.attendanceRule.enabled}
            compact
            disabled={busy.attendance}
            label="출석 알림 사용"
            onChange={(checked) =>
              setView((current) =>
                updateLoaded(current, (loaded) => ({
                  ...loaded,
                  attendanceRule: {
                    ...loaded.attendanceRule,
                    enabled: checked,
                  },
                  attendanceDirty: true,
                })),
              )
            }
          />
          <div className="toggle-grid">
            <SettingSwitch
              ariaLabel="오전 출석 알림"
              checked={view.attendanceRule.morning}
              compact
              disabled={
                busy.attendance || !view.attendanceRule.enabled
              }
              label="오전"
              onChange={(checked) =>
                setView((current) =>
                  updateLoaded(current, (loaded) => ({
                    ...loaded,
                    attendanceRule: {
                      ...loaded.attendanceRule,
                      morning: checked,
                    },
                    attendanceDirty: true,
                  })),
                )
              }
            />
            <SettingSwitch
              ariaLabel="오후 출석 알림"
              checked={view.attendanceRule.evening}
              compact
              disabled={
                busy.attendance || !view.attendanceRule.enabled
              }
              label="오후"
              onChange={(checked) =>
                setView((current) =>
                  updateLoaded(current, (loaded) => ({
                    ...loaded,
                    attendanceRule: {
                      ...loaded.attendanceRule,
                      evening: checked,
                    },
                    attendanceDirty: true,
                  })),
                )
              }
            />
          </div>
          <button
            className="secondary-button settings-action"
            type="button"
            disabled={busy.attendance || !view.attendanceDirty}
            onClick={() => void saveAttendanceRule()}
          >
            {busy.attendance ? "저장 중" : "출석 알림 저장"}
          </button>
          {view.attendanceDirty ? (
            <p className="metadata">아직 저장하지 않은 변경이 있어요.</p>
          ) : null}
        </fieldset>

        <fieldset className="settings-group" aria-busy={busy.meal}>
          <legend>급식 알림</legend>
          <p>선택한 식단이 올라오면 연결된 모든 기기로 알려드려요.</p>
          <div className="toggle-grid">
            {(
              Object.keys(mealLabels) as Array<
                keyof typeof mealLabels
              >
            ).map((meal) => (
              <SettingSwitch
                ariaLabel={`${mealLabels[meal]} 알림`}
                checked={view.mealRule[meal]}
                compact
                disabled={busy.meal || !view.mealRule.enabled}
                key={meal}
                label={mealLabels[meal]}
                onChange={() => updateMeal(meal)}
              />
            ))}
          </div>
          <button
            className="secondary-button settings-action"
            type="button"
            disabled={busy.meal || !view.mealDirty}
            onClick={() => void saveMealRule()}
          >
            {busy.meal ? "저장 중" : "급식 알림 저장"}
          </button>
          {view.mealDirty ? (
            <p className="metadata">아직 저장하지 않은 변경이 있어요.</p>
          ) : null}
        </fieldset>

        <fieldset className="settings-group" aria-busy={laundryDisabled}>
          <legend>세탁 알림</legend>
          <p>
            사용 중인 기기는 현재 동작 기준으로, 비어 있는 기기는 다음 사용
            가능 전환을 기준으로 알려드려요.
          </p>
          <div className="inline-control">
            <SelectControl
              ariaLabel="세탁 알림 기기"
              disabled={laundryDisabled || view.targets.length === 0}
              emptyLabel="기기 정보 없음"
              options={view.targets.map((target) => ({
                value: target.key,
                label: target.label,
              }))}
              value={selectedTargetKey}
              onChange={setSelectedTargetKey}
            />
            <button
              className="secondary-button"
              type="button"
              disabled={
                laundryDisabled ||
                view.targets.length === 0 ||
                duplicateSelectedWatch
              }
              onClick={() => void addWatch()}
            >
              {duplicateSelectedWatch
                ? "이미 등록됨"
                : busy.laundry
                  ? "처리 중"
                  : "세탁 알림 추가"}
            </button>
          </div>
          {duplicateSelectedWatch ? (
            <p className="metadata">
              이 기기에 같은 조건의 알림이 이미 있어요.
            </p>
          ) : null}
          <WatchList
            watches={view.watches}
            busy={laundryDisabled}
            onCancel={(id) => void cancelWatch(id)}
          />
        </fieldset>

        <fieldset className="settings-group" aria-busy={queueDisabled}>
          <legend>자율 대기열</legend>
          <p>
            이 대기열은 자율적인 순서 공유일 뿐이며 실제 기기 예약·사용 권한을
            만들거나 보장하지 않아요.
          </p>
          <div className="button-row">
            <button
              className="secondary-button"
              type="button"
              disabled={
                queueDisabled || hasWaitingQueue(view.queue, "washer")
              }
              onClick={() => void joinQueue("washer")}
            >
              세탁기 대기열 참여
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={
                queueDisabled || hasWaitingQueue(view.queue, "dryer")
              }
              onClick={() => void joinQueue("dryer")}
            >
              건조기 대기열 참여
            </button>
          </div>
          <QueueList
            entries={view.queue}
            busy={queueDisabled}
            onLeave={(id) => void leaveQueue(id)}
          />
        </fieldset>
      </div>

      {message ? (
        <p className="notice" aria-live="polite">
          {message}
        </p>
      ) : null}
    </section>
  );
}

function WatchList({
  watches,
  busy,
  onCancel,
}: {
  watches: readonly LaundryWatchDto[];
  busy: boolean;
  onCancel: (id: string) => void;
}) {
  const active = watches.filter((watch) => watch.status === "active");
  if (active.length === 0) {
    return <p className="metadata">등록한 세탁 알림이 없어요.</p>;
  }
  return (
    <ul className="compact-list">
      {active.map((watch) => (
        <li key={watch.id}>
          <span>
            {machineLabel(watch.machineId)} ·{" "}
            {applianceLabel(watch.appliance)} ·{" "}
            {watchConditionLabel(watch)}
          </span>
          <button
            className="compact-button"
            type="button"
            disabled={busy}
            onClick={() => onCancel(watch.id)}
          >
            알림 취소
          </button>
        </li>
      ))}
    </ul>
  );
}

function QueueList({
  entries,
  busy,
  onLeave,
}: {
  entries: readonly LaundryQueueEntryDto[];
  busy: boolean;
  onLeave: (id: string) => void;
}) {
  const visible = entries.filter((entry) => entry.status !== "cancelled");
  if (visible.length === 0) {
    return <p className="metadata">참여 중인 대기열이 없어요.</p>;
  }
  return (
    <ul className="compact-list">
      {visible.map((entry) => (
        <li key={entry.id}>
          <span>
            {applianceLabel(entry.appliance)} · {queueStatusLabel(entry)}
          </span>
          {entry.status === "waiting" ? (
            <button
              className="compact-button"
              type="button"
              disabled={busy}
              onClick={() => onLeave(entry.id)}
            >
              대기 취소
            </button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function laundryTargets(
  machines: readonly {
    readonly id: string;
    readonly washer: LaundryAppliance | null;
    readonly dryer: LaundryAppliance | null;
  }[],
): LaundryTarget[] {
  const targets: LaundryTarget[] = [];
  for (const machine of machines) {
    for (const appliance of [machine.washer, machine.dryer]) {
      if (appliance === null) {
        continue;
      }
      const running = hasActiveLaundrySession(appliance);
      const targetSessionId = running ? appliance.sessionId : null;
      const remainingMinutes =
        appliance.projection.remainingMinutes ??
        appliance.remainingMinutes;
      const showRemaining =
        running &&
        appliance.operationalStatus !== "ERROR" &&
        appliance.projection.status !== "ERROR";
      const condition = running
        ? "알림 조건: 이 동작 종료 10분 전·완료·사용 가능 전환"
        : "알림 조건: 다음 사용 후 사용 가능 전환";
      targets.push({
        key: `${machine.id}:${appliance.appliance}`,
        machineId: machine.id,
        appliance: appliance.appliance,
        sessionId: targetSessionId,
        label: [
          machineLabel(machine.id),
          applianceLabel(appliance.appliance),
          applianceStateLabel(appliance, running),
          showRemaining && remainingMinutes !== null
            ? `${remainingMinutes}분 남음`
            : null,
          condition,
        ]
          .filter((part): part is string => part !== null)
          .join(" · "),
      });
    }
  }
  return targets;
}

function updateLoaded(
  state: ViewState,
  update: (loaded: LoadedView) => LoadedView,
): ViewState {
  return state.state === "loaded" ? update(state) : state;
}

function mealRuleInput(rule: MealRuleDto): MealRuleInput {
  return {
    enabled: rule.enabled,
    breakfast: rule.breakfast,
    lunch: rule.lunch,
    dinner: rule.dinner,
  };
}

function attendanceRuleInput(
  rule: AttendanceRuleDto,
): AttendanceRuleInput {
  return {
    enabled: rule.enabled,
    morning: rule.morning,
    evening: rule.evening,
  };
}

function sameMealRule(rule: MealRuleDto, input: MealRuleInput): boolean {
  return (
    rule.enabled === input.enabled &&
    rule.breakfast === input.breakfast &&
    rule.lunch === input.lunch &&
    rule.dinner === input.dinner
  );
}

function sameAttendanceRule(
  rule: AttendanceRuleDto,
  input: AttendanceRuleInput,
): boolean {
  return (
    rule.enabled === input.enabled &&
    rule.morning === input.morning &&
    rule.evening === input.evening
  );
}

function hasDuplicateActiveWatch(
  watches: readonly LaundryWatchDto[],
  target: LaundryTarget,
): boolean {
  return watches.some(
    (watch) =>
      watch.status === "active" &&
      watch.machineId === target.machineId &&
      watch.appliance === target.appliance &&
      (target.sessionId === null
        ? watch.sessionId === null && watch.notifyWhenAvailable
        : watch.sessionId === target.sessionId),
  );
}

function upsertWatch(
  watches: readonly LaundryWatchDto[],
  created: LaundryWatchDto,
): readonly LaundryWatchDto[] {
  return [
    created,
    ...watches.filter((watch) => watch.id !== created.id),
  ];
}

function upsertQueueEntry(
  entries: readonly LaundryQueueEntryDto[],
  created: LaundryQueueEntryDto,
): readonly LaundryQueueEntryDto[] {
  return [
    created,
    ...entries.filter((entry) => entry.id !== created.id),
  ];
}

function selectAvailableTarget(
  current: string,
  targets: readonly LaundryTarget[],
): string {
  return targets.some((target) => target.key === current)
    ? current
    : targets[0]?.key ?? "";
}

function hasWaitingQueue(
  entries: readonly LaundryQueueEntryDto[],
  appliance: ApplianceKind,
): boolean {
  return entries.some(
    (entry) =>
      entry.status === "waiting" && entry.appliance === appliance,
  );
}

function watchConditionLabel(watch: LaundryWatchDto): string {
  if (watch.sessionId === null) {
    return watch.notifyWhenAvailable
      ? "다음 사용 후 사용 가능 전환 알림"
      : "사용 가능 전환 알림 꺼짐";
  }
  const before =
    watch.notifyBeforeMinutes > 0
      ? `이 동작 종료 ${watch.notifyBeforeMinutes}분 전·완료`
      : "이 동작 완료";
  return watch.notifyWhenAvailable
    ? `${before}·사용 가능 전환 알림`
    : `${before} 알림`;
}

function queueStatusLabel(entry: LaundryQueueEntryDto): string {
  if (entry.status === "waiting") {
    return `대기 중 · 현재 ${entry.position ?? "—"}번째`;
  }
  if (entry.status === "claimed") {
    return "순번 도착 처리됨";
  }
  if (entry.status === "expired") {
    return "대기 만료";
  }
  return "참여 취소";
}

function applianceStateLabel(
  appliance: LaundryAppliance,
  running: boolean,
): string {
  if (
    appliance.operationalStatus === "ERROR" ||
    appliance.projection.status === "ERROR"
  ) {
    return "오류";
  }
  if (
    appliance.operationalStatus === "PAUSED" ||
    appliance.projection.status === "PAUSED"
  ) {
    return "일시 정지";
  }
  if (running) {
    return "사용 중";
  }
  if (
    appliance.operationalStatus === "AVAILABLE" ||
    appliance.operationalStatus === "IDLE" ||
    appliance.operationalStatus === "READY"
  ) {
    return "사용 가능";
  }
  if (appliance.operationalStatus === "COMPLETED") {
    return "동작 완료";
  }
  return `상태 ${appliance.operationalStatus}`;
}

function formatUpdatedTime(epochMs: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(epochMs);
}

function machineLabel(value: string): string {
  return value.replaceAll("_", " ");
}

function applianceLabel(value: ApplianceKind): string {
  return value === "washer" ? "세탁기" : "건조기";
}
