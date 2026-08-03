import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  getCompanionAttendanceDashboard,
  getDesktopAttendanceDashboard,
  getVapidPublicKey,
  registerPushSubscription,
  revokePushSubscription,
  sendServerPushTest,
  type AttendanceDashboardResult,
  type AttendanceDto,
  type AttendanceSnapshotDto,
  type DesktopDeviceDto,
  type DesktopAuthState,
  type DesktopAuthStatus,
} from "./api-client";
import { DesktopPairing } from "./components/DesktopPairing";
import { DesktopLmsManager } from "./components/DesktopLmsManager";
import { MobilePairing } from "./components/MobilePairing";
import { MobileSessionManager } from "./components/MobileSessionManager";
import { PersonalControls } from "./components/PersonalControls";
import { PublicInformation } from "./components/PublicInformation";
import {
  notificationChannelFor,
  type NotificationChannel,
} from "./notification-channel";
import { sendLocalTestNotification } from "./notifications";
import {
  clearBrowserPushState,
  readStoredPushSubscriptionId,
  storePushSubscriptionId,
} from "./push-local-state";
import { resolveSurface } from "./surface";
import { isDesktopRuntime } from "./runtime";
import {
  BrowserWebPushManager,
  detectWebPushCapability,
  requestWebPushPermissionFromUserGesture,
  serializeBrowserSubscription,
} from "./web-push";
import logoUrl from "./assets/logo.png";

interface AppProps {
  initialPath?: string;
  tauri?: boolean;
}

type WorkspaceRouteId =
  | "attendance"
  | "laundry"
  | "meals"
  | "notifications"
  | "settings";

interface WorkspaceRoute {
  readonly id: WorkspaceRouteId;
  readonly hash: `#${string}`;
  readonly label: string;
  readonly intro: {
    readonly eyebrow: string;
    readonly title: string;
    readonly description: string;
  };
}

const WORKSPACE_ROUTES = [
  {
    id: "attendance",
    hash: "#attendance",
    label: "홈",
    intro: {
      eyebrow: "내 정글벨",
      title: "오늘의 정글 생활",
      description: "출석 상태와 LMS 연결 상태를 한곳에서 확인해요.",
    },
  },
  {
    id: "laundry",
    hash: "#laundry",
    label: "세탁",
    intro: {
      eyebrow: "생활 정보",
      title: "세탁",
      description: "건조까지 바로 이어서 사용할 수 있는 워시타워를 확인해요.",
    },
  },
  {
    id: "meals",
    hash: "#meals",
    label: "급식",
    intro: {
      eyebrow: "생활 정보",
      title: "급식",
      description: "오늘 제공되는 식단을 시간대별로 확인해요.",
    },
  },
  {
    id: "notifications",
    hash: "#notifications",
    label: "알림",
    intro: {
      eyebrow: "내 정글벨",
      title: "알림 관리",
      description: "출석과 생활 알림을 받을 시간과 기기를 관리해요.",
    },
  },
  {
    id: "settings",
    hash: "#settings",
    label: "설정",
    intro: {
      eyebrow: "내 정글벨",
      title: "설정",
      description: "휴대폰 연결과 로그인된 기기를 관리해요.",
    },
  },
] as const satisfies readonly WorkspaceRoute[];

function workspaceRouteFromHash(hash: string): WorkspaceRouteId {
  const normalizedHash = hash.toLowerCase();
  if (normalizedHash === "#devices") {
    return "settings";
  }
  return (
    WORKSPACE_ROUTES.find(({ hash: routeHash }) => routeHash === normalizedHash)
      ?.id ?? "attendance"
  );
}

type AttendanceViewState =
  | { readonly state: "loading" }
  | { readonly state: "auth-required" }
  | { readonly state: "error" }
  | {
      readonly state: "loaded";
      readonly attendance: AttendanceDto;
      readonly devices: readonly DesktopDeviceDto[];
    };

type AttendanceAuthState = AttendanceViewState["state"];

function AttendanceCard({
  surface,
  refreshKey,
  onAuthStateChange,
}: {
  surface: "desktop" | "companion";
  refreshKey: number;
  onAuthStateChange?: (state: AttendanceAuthState) => void;
}) {
  const [view, setView] = useState<AttendanceViewState>({
    state: "loading",
  });

  useEffect(() => {
    let active = true;
    const load = (showLoading: boolean) => {
      if (showLoading) {
        setView({ state: "loading" });
        onAuthStateChange?.("loading");
      }
      const request =
        surface === "desktop"
          ? getDesktopAttendanceDashboard()
          : getCompanionAttendanceDashboard();
      void request
        .then((result) => {
          if (active) {
            const next = attendanceView(result);
            setView(next);
            onAuthStateChange?.(next.state);
          }
        })
        .catch(() => {
          if (active) {
            setView({ state: "error" });
            onAuthStateChange?.("error");
          }
        });
    };
    load(true);
    const intervalId = window.setInterval(() => load(false), 60_000);
    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [onAuthStateChange, refreshKey, surface]);

  return (
    <article
      id="attendance"
      className="card attendance-card"
      aria-busy={view.state === "loading"}
      aria-live="polite"
    >
      <div>
        <div className="eyebrow">오늘 출석</div>
        <h2>출석 상태</h2>
      </div>
      <AttendanceContent surface={surface} view={view} />
    </article>
  );
}

function attendanceView(
  result: AttendanceDashboardResult,
): AttendanceViewState {
  return result.state === "auth-required"
    ? { state: "auth-required" }
    : {
        state: "loaded",
        attendance: result.attendance,
        devices: result.devices,
      };
}

function AttendanceContent({
  surface,
  view,
}: {
  surface: "desktop" | "companion";
  view: AttendanceViewState;
}) {
  if (view.state === "loading") {
    return (
      <>
        <AttendanceState modifier="pending">
          출석 정보를 확인하고 있어요
        </AttendanceState>
        <p className="muted">최근에 동기화한 출석 상태를 불러오고 있어요.</p>
      </>
    );
  }
  if (view.state === "auth-required") {
    return (
      <>
        <AttendanceState modifier="warning">
          PC 연결이 필요해요
        </AttendanceState>
        <p className="muted">
          {surface === "desktop"
            ? "이 PC에서 LMS 로그인을 마치면 출석 상태를 확인할 수 있어요."
            : "PC 앱에서 이 휴대폰을 다시 연결해 주세요."}
        </p>
      </>
    );
  }
  if (view.state === "error") {
    return (
      <>
        <AttendanceState modifier="error">
          출석 정보를 불러오지 못했어요
        </AttendanceState>
        <p className="muted">잠시 후 다시 확인해 주세요.</p>
      </>
    );
  }
  if (view.attendance.status === "unavailable") {
    return (
      <>
        <AttendanceState modifier="pending">
          출석 확인 대기 중
        </AttendanceState>
        <p className="muted">
          아직 PC에서 확인한 출석 정보가 없어요.
        </p>
        <DeviceStateNotice devices={view.devices} />
      </>
    );
  }

  const { attendance } = view;
  const snapshot = attendance.snapshot;
  const attendanceDateRelation = compareWithTodayInSeoul(
    snapshot.attendanceDate,
  );
  const attendanceDateLabel = formatAttendanceFullDate(
    snapshot.attendanceDate,
  );
  const primaryState = attendancePrimaryState(snapshot);
  return (
    <>
      <AttendanceState modifier={primaryState.modifier}>
        {primaryState.label}
      </AttendanceState>
      <p className="metadata">
        출석 기준일 ·{" "}
        <time dateTime={snapshot.attendanceDate}>
          {attendanceDateLabel}
        </time>
        {attendanceDateRelation === "today" ? " (오늘)" : ""}
      </p>
      {snapshot.cohortStatus === "active" ? (
        <div
          className="attendance-checks"
          aria-label={
            attendanceDateRelation === "today"
              ? "오늘 출석 상태"
              : `${attendanceDateLabel} 출석 상태`
          }
        >
          <span
            className={`attendance-check ${
              snapshot.morningChecked ? "checked" : "unchecked"
            }`}
          >
            오전 출석 {snapshot.morningChecked ? "완료" : "미완료"}
          </span>
          <span
            className={`attendance-check ${
              snapshot.eveningChecked ? "checked" : "unchecked"
            }`}
          >
            오후 출석 {snapshot.eveningChecked ? "완료" : "미완료"}
          </span>
        </div>
      ) : null}
      <p className="attendance-cohort">
        {snapshot.cohortStatus === "active" ? (
          <span className="ui-badge">
            {cohortStatusLabel(snapshot.cohortStatus)}
          </span>
        ) : null}
        <span>{cohortDescription(snapshot)}</span>
      </p>
      <p className="metadata">
        마지막 동기화 ·{" "}
        <time dateTime={attendance.lastSyncedAt}>
          {formatAttendanceTimestamp(attendance.lastSyncedAt)}
        </time>
      </p>
      {attendance.freshness === "stale" ? (
        <p className="attendance-session-warning">
          마지막 확인 이후 시간이 지났어요. PC 앱을 실행해 다시
          확인해 주세요.
        </p>
      ) : null}
      {attendanceDateRelation !== "today" ? (
        <p className="attendance-session-warning">
          {attendanceDateRelation === "past"
            ? "지난 날짜의 출석 정보예요. 오늘 출석과 혼동하지 않도록 확인해 주세요."
            : "출석 날짜가 오늘보다 뒤예요. PC의 날짜와 동기화 상태를 확인해 주세요."}
        </p>
      ) : null}
      <DeviceStateNotice
        devices={view.devices}
        sourceDeviceId={snapshot.sourceDeviceId}
      />
    </>
  );
}

function attendancePrimaryState(snapshot: AttendanceSnapshotDto): {
  readonly label: string;
  readonly modifier: string;
} {
  if (snapshot.cohortStatus !== "active") {
    return {
      label: cohortStatusLabel(snapshot.cohortStatus),
      modifier: snapshot.cohortStatus,
    };
  }
  if (snapshot.morningChecked && snapshot.eveningChecked) {
    return { label: "오늘 출석 완료", modifier: "active" };
  }
  if (!snapshot.morningChecked && !snapshot.eveningChecked) {
    return { label: "오늘 출석 확인 필요", modifier: "warning" };
  }
  return {
    label: snapshot.morningChecked
      ? "오후 출석 확인 필요"
      : "오전 출석 확인 필요",
    modifier: "warning",
  };
}

function AttendanceState({
  children,
  modifier,
}: {
  children: ReactNode;
  modifier: string;
}) {
  return (
    <div className={`attendance-state ${modifier}`}>
      <span className="dot attendance-dot" />
      {children}
    </div>
  );
}

function DeviceStateNotice({
  devices,
  sourceDeviceId = null,
}: {
  devices: readonly DesktopDeviceDto[];
  sourceDeviceId?: string | null;
}) {
  if (devices.length === 0) {
    return (
      <p className="attendance-session-warning">
        출석을 확인할 PC가 없어요. PC 앱에서 LMS 로그인을 완료해
        주세요.
      </p>
    );
  }
  const connectedCount = devices.filter(
    (device) =>
      device.lmsSessionState === "connected" &&
      device.health === "online",
  ).length;
  const loginRequiredCount = devices.filter(
    (device) => device.lmsSessionState === "login-required",
  ).length;
  return (
    <div className="desktop-device-state">
      <p className="metadata">내 출석 확인 PC</p>
      <ul className="compact-list" aria-label="출석 확인 PC 상태">
        {devices.map((device, index) => (
          <li key={device.id}>
            <span>
              <strong>PC {index + 1}</strong>
              {device.id === sourceDeviceId ? " · 최근 출석 확인" : ""}
            </span>
            <span className="metadata">
              {desktopHealthLabel(device.health)}
              {" · "}
              {desktopLmsStateLabel(device.lmsSessionState)}
              {device.lastSeenAt ? (
                <>
                  {" · "}
                  <time dateTime={device.lastSeenAt}>
                    {formatAttendanceTimestamp(device.lastSeenAt)}
                  </time>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      {loginRequiredCount > 0 ? (
        <p className="attendance-session-warning">
          {loginRequiredCount === devices.length
            ? "PC의 LMS 로그인이 만료됐어요. PC 앱에서 다시 로그인해 주세요."
            : `${loginRequiredCount}대의 PC에서 LMS 로그인을 다시 확인해야 해요.`}
        </p>
      ) : connectedCount === 0 ? (
        <p className="attendance-session-warning">
          현재 출석을 확인하는 PC가 없어요. PC 앱을 실행해 주세요.
        </p>
      ) : null}
    </div>
  );
}

function desktopHealthLabel(health: DesktopDeviceDto["health"]): string {
  switch (health) {
    case "online":
      return "온라인";
    case "offline":
      return "오프라인";
    case "unknown":
      return "상태 미확인";
  }
}

function desktopLmsStateLabel(
  state: DesktopDeviceDto["lmsSessionState"],
): string {
  switch (state) {
    case "connected":
      return "LMS 연결됨";
    case "login-required":
      return "LMS 로그인 필요";
    case "unknown":
      return "LMS 상태 미확인";
  }
}

function cohortStatusLabel(
  status: AttendanceSnapshotDto["cohortStatus"],
): string {
  switch (status) {
    case "active":
      return "학습 기간";
    case "upcoming":
      return "학습 시작 전";
    case "ended":
      return "학습 종료";
    case "none":
      return "기수 정보 없음";
    case "unknown":
      return "학습 기간 확인 필요";
  }
}

function cohortDescription(snapshot: AttendanceSnapshotDto): string {
  if (snapshot.cohortStatus === "none") {
    return "현재 확인할 수 있는 기수 정보가 없어요.";
  }
  if (snapshot.cohortStatus === "unknown") {
    return "LMS에서 학습 기간을 확인하지 못했어요.";
  }
  const range = [
    snapshot.cohortStartDate
      ? formatAttendanceDate(snapshot.cohortStartDate)
      : null,
    snapshot.cohortEndDate
      ? formatAttendanceDate(snapshot.cohortEndDate)
      : "종료일 미정",
  ]
    .filter((value): value is string => value !== null)
    .join("–");
  return range || "학습 기간 정보 없음";
}

function formatAttendanceDate(value: string): string {
  const [, month = "", day = ""] = value.split("-");
  return `${Number(month)}월 ${Number(day)}일`;
}

function formatAttendanceFullDate(value: string): string {
  const [year = "", month = "", day = ""] = value.split("-");
  return `${Number(year)}년 ${Number(month)}월 ${Number(day)}일`;
}

function compareWithTodayInSeoul(
  attendanceDate: string,
  now = new Date(),
): "past" | "today" | "future" {
  const today = dateInSeoul(now);
  if (attendanceDate === today) {
    return "today";
  }
  return attendanceDate < today ? "past" : "future";
}

function dateInSeoul(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function formatAttendanceTimestamp(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function NotificationSettings({
  channel,
}: {
  channel: NotificationChannel;
}) {
  const [testResult, setTestResult] = useState<string>("");
  const [pushSubscriptionId, setPushSubscriptionId] = useState<string | null>(
    () => readStoredPushSubscriptionId(),
  );
  const [busy, setBusy] = useState(false);
  const testButtonLabel =
    channel === "web-push"
      ? pushSubscriptionId
        ? "알림 보내보기"
        : "기기 알림 테스트"
      : "PC 알림 테스트";

  useEffect(() => {
    if (channel !== "web-push" || pushSubscriptionId === null) {
      return;
    }
    let active = true;
    void (async () => {
      try {
        const registration =
          "serviceWorker" in navigator
            ? await navigator.serviceWorker.getRegistration()
            : undefined;
        const subscription =
          await registration?.pushManager.getSubscription();
        if (!active) {
          return;
        }
        if (subscription === undefined) {
          setTestResult(
            "브라우저 알림 상태를 아직 확인하지 못했어요. 앱을 다시 열어 주세요.",
          );
          return;
        }
        if (subscription === null) {
          const capability = detectWebPushCapability();
          if (
            registration !== undefined &&
            capability.eligible &&
            capability.permission === "granted"
          ) {
            const { publicKey } = await getVapidPublicKey();
            const manager = new BrowserWebPushManager({
              publicVapidKey: publicKey,
              getPermission: () => Notification.permission,
              serviceWorkerReady: Promise.resolve(registration),
            });
            const recovered = await manager.subscribe();
            const registered = await registerPushSubscription(recovered);
            if (!active) {
              return;
            }
            storePushSubscriptionId(registered.subscriptionId);
            setPushSubscriptionId(registered.subscriptionId);
            setTestResult(
              "만료된 브라우저 알림을 다시 연결했어요.",
            );
            return;
          }
          storePushSubscriptionId(null);
          setPushSubscriptionId(null);
          setTestResult(
            "브라우저 알림 연결이 없어 표시를 초기화했어요.",
          );
          return;
        }
        const registered = await registerPushSubscription(
          serializeBrowserSubscription(subscription),
        );
        if (!active) {
          return;
        }
        storePushSubscriptionId(registered.subscriptionId);
        setPushSubscriptionId(registered.subscriptionId);
      } catch {
        if (active) {
          setTestResult(
            "브라우저 알림 상태를 확인하지 못했어요. 네트워크 연결 후 다시 열어 주세요.",
          );
        }
      }
    })();
    return () => {
      active = false;
    };
    // Reconcile the initial browser/server state once when the card mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel]);

  useEffect(() => {
    if (
      channel !== "web-push" ||
      !("serviceWorker" in navigator) ||
      typeof navigator.serviceWorker.addEventListener !== "function" ||
      typeof navigator.serviceWorker.removeEventListener !== "function"
    ) {
      return;
    }
    const receiveSubscriptionUpdate = (event: MessageEvent<unknown>) => {
      if (
        typeof event.data !== "object" ||
        event.data === null ||
        !("type" in event.data)
      ) {
        return;
      }
      const message = event.data as {
        readonly type?: unknown;
        readonly subscriptionId?: unknown;
      };
      if (message.type === "push-subscription-invalidated") {
        storePushSubscriptionId(null);
        setPushSubscriptionId(null);
        setTestResult(
          "브라우저 알림 연결이 만료되어 표시를 초기화했어요.",
        );
      } else if (
        message.type === "push-subscription-reconciled" &&
        typeof message.subscriptionId === "string" &&
        /^jbps_[0-9a-f]{64}$/u.test(message.subscriptionId)
      ) {
        storePushSubscriptionId(message.subscriptionId);
        setPushSubscriptionId(message.subscriptionId);
        setTestResult("변경된 브라우저 알림을 다시 연결했어요.");
      } else if (message.type === "push-subscription-reconcile-failed") {
        setTestResult(
          "변경된 브라우저 알림을 연결하지 못했어요. 앱을 다시 열어 주세요.",
        );
      }
    };
    navigator.serviceWorker.addEventListener(
      "message",
      receiveSubscriptionUpdate,
    );
    return () =>
      navigator.serviceWorker.removeEventListener(
        "message",
        receiveSubscriptionUpdate,
      );
  }, [channel]);

  const testNotification = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      if (channel === "web-push" && pushSubscriptionId) {
        try {
          const { results } = await sendServerPushTest();
          const inactive = results.some(
            ({ status }) =>
              status === "subscription-inactive" ||
              status === "subscription-revoked",
          );
          if (inactive) {
            storePushSubscriptionId(null);
            setPushSubscriptionId(null);
          }
          setTestResult(
            results.some(({ status }) => status === "delivered")
              ? "이 기기로 테스트 알림을 보냈어요."
              : inactive
                ? "브라우저 알림 연결이 만료됐어요. 연결을 해제한 뒤 다시 연결해 주세요."
                : "테스트 알림을 보내지 못했어요.",
          );
        } catch {
          setTestResult("테스트 알림을 보내지 못했어요.");
        }
        return;
      }
      const result = await sendLocalTestNotification(channel);
      setTestResult(
        result === "sent"
          ? channel === "web-push"
            ? "이 기기에 테스트 알림을 표시했어요. 원격 알림 연결은 아직 확인하지 않았어요."
            : "PC 테스트 알림을 보냈어요."
          : result === "denied"
            ? "알림 권한이 꺼져 있어요."
            : "이 환경에서는 알림을 사용할 수 없어요.",
      );
    } catch {
      setTestResult("테스트 알림을 표시하지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const connectWebPush = async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      const permission =
        await requestWebPushPermissionFromUserGesture();
      if (permission !== "granted") {
        setTestResult("알림 권한이 꺼져 있어요.");
        return;
      }
      const { publicKey } = await getVapidPublicKey();
      const manager = new BrowserWebPushManager({
        publicVapidKey: publicKey,
        getPermission: () => Notification.permission,
        serviceWorkerReady: navigator.serviceWorker.ready,
      });
      const subscription = await manager.subscribe();
      const registered = await registerPushSubscription(subscription);
      storePushSubscriptionId(registered.subscriptionId);
      setPushSubscriptionId(registered.subscriptionId);
      setTestResult("이 기기의 브라우저 알림을 연결했어요.");
    } catch (error) {
      setTestResult(webPushErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnectWebPush = async () => {
    if (!pushSubscriptionId || busy) {
      return;
    }
    setBusy(true);
    let serverRevoked = false;
    let browserUnsubscribed = false;
    try {
      await revokePushSubscription(pushSubscriptionId);
      serverRevoked = true;
    } catch {
      // A stale local identifier can belong to a previous pairing. Browser
      // cleanup must still proceed so the user can register a new endpoint.
    }
    try {
      browserUnsubscribed = await clearBrowserPushState();
    } catch {
      browserUnsubscribed = false;
    }
    storePushSubscriptionId(null);
    setPushSubscriptionId(null);
    if (serverRevoked && browserUnsubscribed) {
      setTestResult("이 기기의 브라우저 알림을 해제했어요.");
    } else if (browserUnsubscribed) {
      setTestResult(
        "브라우저 알림은 해제했지만 서버 상태는 확인하지 못했어요.",
      );
    } else {
      setTestResult("브라우저 알림을 해제하지 못했어요.");
    }
    setBusy(false);
  };

  return (
    <section
      className="settings-section settings-card device-notification-settings"
      aria-labelledby="device-notification-title"
    >
      <header className="device-notification-settings__header">
        <div>
          <div className="eyebrow">이 기기</div>
          <h2 id="device-notification-title">알림 받기</h2>
        </div>
        <button
          className="secondary-button"
          disabled={busy}
          type="button"
          onClick={testNotification}
        >
          {testButtonLabel}
        </button>
      </header>
      {channel === "web-push" ? (
        <div className="settings-row">
          <div className="settings-row__copy">
            <strong>브라우저 알림</strong>
            <span>
              iPhone·iPad에서는 홈 화면에 추가한 Jungle Bell에서 알림을
              연결해 주세요.
            </span>
          </div>
          <button
            className="secondary-button"
            disabled={busy}
            type="button"
            onClick={
              pushSubscriptionId ? disconnectWebPush : connectWebPush
            }
          >
            {pushSubscriptionId ? "브라우저 알림 해제" : "브라우저 알림 연결"}
          </button>
        </div>
      ) : (
        <div className="settings-row">
          <div className="settings-row__copy">
            <strong>PC 네이티브 알림</strong>
            <span>
              PC 앱을 실행해 두면 필요한 알림을 운영체제에 표시해요.
            </span>
          </div>
          <span className="ui-badge ui-badge--success">사용 가능</span>
        </div>
      )}
      {testResult ? <p className="notice" role="status">{testResult}</p> : null}
    </section>
  );
}

function webPushErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : error instanceof Error
        ? error.message
        : "";
  switch (code) {
    case "PWA_INSTALL_REQUIRED":
      return "Jungle Bell을 홈 화면에 추가한 뒤 앱 아이콘으로 열어 주세요.";
    case "PERMISSION_DENIED":
      return "브라우저 설정에서 알림 권한을 허용해 주세요.";
    case "INSECURE_CONTEXT":
      return "브라우저 알림은 안전한 HTTPS 연결에서만 사용할 수 있어요.";
    case "UNSUPPORTED":
      return "이 브라우저에서는 알림을 사용할 수 없어요.";
    default:
      return "브라우저 알림을 연결하지 못했어요.";
  }
}

export function App({
  initialPath = window.location.pathname,
  tauri = isDesktopRuntime(),
}: AppProps) {
  const surface = useMemo(
    () => resolveSurface(initialPath, tauri),
    [initialPath, tauri],
  );
  const channel = notificationChannelFor(surface.kind, tauri);
  const [desktopAuthState, setDesktopAuthState] = useState<
    DesktopAuthState | "loading"
  >("loading");
  const [desktopHealth, setDesktopHealth] = useState<
    DesktopAuthStatus["health"]
  >(null);
  const [attendanceRefreshKey, setAttendanceRefreshKey] = useState(0);
  const [companionAuthState, setCompanionAuthState] =
    useState<AttendanceAuthState>("loading");
  const [selectedWorkspaceRoute, setSelectedWorkspaceRoute] = useState(
    () => workspaceRouteFromHash(window.location.hash),
  );
  useEffect(() => {
    const followWorkspaceLink = () => {
      setSelectedWorkspaceRoute(workspaceRouteFromHash(window.location.hash));
    };
    window.addEventListener("hashchange", followWorkspaceLink);
    return () => {
      window.removeEventListener("hashchange", followWorkspaceLink);
    };
  }, []);
  const pairingEnabled =
    desktopAuthState === "connected" && desktopHealth === "online";
  const personalControlsEnabled =
    surface.kind === "companion"
      ? companionAuthState === "loaded"
      : desktopAuthState !== "loading" &&
        desktopAuthState !== "disconnected";
  const handleCompanionAuthState = useCallback(
    (state: AttendanceAuthState) => {
      setCompanionAuthState(state);
    },
    [],
  );
  const handleDesktopStatus = (status: DesktopAuthStatus) => {
    setDesktopAuthState(status.state);
    setDesktopHealth(status.health);
    setAttendanceRefreshKey((current) => current + 1);
  };
  const selectedRoute =
    WORKSPACE_ROUTES.find(({ id }) => id === selectedWorkspaceRoute) ??
    WORKSPACE_ROUTES[0];

  if (initialPath.startsWith("/pair")) {
    return (
      <div className="app-shell">
        <AppHeader badge="기기 연결" />
        <MobilePairing fragment={window.location.hash} />
      </div>
    );
  }

  const badge = surfaceBadge(
    surface.kind,
    desktopAuthState,
    desktopHealth,
    companionAuthState,
  );

  return (
    <div className="app-shell">
      <AppHeader badge={badge.label} tone={badge.tone} />

      <main
        className={`app-main${
          surface.kind === "public" ? "" : " app-main--workspace"
        }`}
      >
        {surface.kind === "public" ? (
          <>
            <PageIntro
              eyebrow="Jungle Bell"
              title="생활 정보"
              description="정글의 급식과 워시타워 현황을 확인하세요."
            />
            <PublicInformation />
          </>
        ) : (
          <div className="workspace-frame">
            <nav className="workspace-navigation" aria-label="정글벨 메뉴">
              <p className="workspace-navigation-title">메뉴</p>
              <ul className="workspace-navigation-list">
                {WORKSPACE_ROUTES.map((route) => {
                  const disabled =
                    route.id === "notifications"
                      ? !personalControlsEnabled
                      : route.id === "settings" &&
                        surface.kind === "companion" &&
                        !personalControlsEnabled;
                  const current = selectedWorkspaceRoute === route.id;
                  return (
                    <li key={route.id}>
                      <a
                        className="workspace-navigation-link"
                        data-route={route.id}
                        href={route.hash}
                        aria-current={current ? "page" : undefined}
                        aria-disabled={disabled || undefined}
                        tabIndex={disabled ? -1 : undefined}
                        onClick={(event) => {
                          event.preventDefault();
                          if (disabled) {
                            return;
                          }
                          setSelectedWorkspaceRoute(route.id);
                          if (window.location.hash !== route.hash) {
                            window.location.hash = route.hash;
                          }
                        }}
                      >
                        <WorkspaceRouteIcon route={route.id} />
                        <span className="workspace-navigation-label">
                          {route.label}
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="workspace-content">
              <section
                className="workspace-page"
                data-workspace-page="attendance"
                hidden={selectedWorkspaceRoute !== "attendance"}
              >
                <PageIntro {...WORKSPACE_ROUTES[0].intro} />
                {surface.kind === "companion" &&
                companionAuthState === "auth-required" ? (
                  <MobilePairing fragment="" manualMode />
                ) : null}
                {surface.canViewAttendance ? (
                  <section className="personal-grid">
                    <AttendanceCard
                      surface={
                        surface.kind === "desktop"
                          ? "desktop"
                          : "companion"
                      }
                      refreshKey={attendanceRefreshKey}
                      {...(surface.kind === "companion"
                        ? { onAuthStateChange: handleCompanionAuthState }
                        : {})}
                    />
                    {surface.canManageLmsSession ? (
                      <DesktopLmsManager
                        onStatusChange={handleDesktopStatus}
                      />
                    ) : null}
                  </section>
                ) : null}
              </section>

              {selectedWorkspaceRoute !== "attendance" ? (
                <section
                  className="workspace-page"
                  data-workspace-page={selectedWorkspaceRoute}
                >
                  <PageIntro {...selectedRoute.intro} />
                  {selectedWorkspaceRoute === "laundry" ? (
                    <PublicInformation view="laundry" />
                  ) : null}
                  {selectedWorkspaceRoute === "meals" ? (
                    <PublicInformation view="meals" />
                  ) : null}
                  {selectedWorkspaceRoute === "notifications" &&
                  surface.canReceivePersonalNotifications &&
                  personalControlsEnabled ? (
                    <>
                      <PersonalControls />
                      <NotificationSettings channel={channel} />
                    </>
                  ) : null}
                  {selectedWorkspaceRoute === "settings" ? (
                    <>
                      {surface.canPair ? (
                        <DesktopPairing enabled={pairingEnabled} />
                      ) : null}
                      {surface.kind === "desktop" &&
                      desktopAuthState !== "loading" &&
                      desktopAuthState !== "disconnected" ? (
                        <MobileSessionManager mode="desktop" />
                      ) : null}
                      {surface.kind === "companion" &&
                      personalControlsEnabled ? (
                        <MobileSessionManager mode="companion" />
                      ) : null}
                    </>
                  ) : null}
                </section>
              ) : null}
            </div>
          </div>
        )}
      </main>

      <footer>
        <span>Jungle Bell</span>
        <span>출석은 LMS 페이지에서 직접 진행해 주세요.</span>
      </footer>
    </div>
  );
}

function AppHeader({
  badge,
  tone = "neutral",
}: {
  readonly badge: string;
  readonly tone?: "neutral" | "success" | "warning";
}) {
  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="Jungle Bell 홈">
        <img className="brand-logo" src={logoUrl} alt="" />
        <span className="brand-copy">
          <strong>Jungle Bell</strong>
          <small>정글 생활을 더 편리하게</small>
        </span>
      </a>
      <span className={`ui-badge ui-badge--${tone}`}>{badge}</span>
    </header>
  );
}

function WorkspaceRouteIcon({
  route,
}: {
  readonly route: WorkspaceRouteId;
}) {
  const icon = (() => {
    switch (route) {
      case "attendance":
        return (
          <>
            <path d="m3 10.5 9-7.5 9 7.5" />
            <path d="M5 9.5V21h14V9.5M9 21v-7h6v7" />
          </>
        );
      case "laundry":
        return (
          <>
            <rect x="4" y="2.5" width="16" height="19" rx="2.5" />
            <path d="M4 8h16" />
            <circle cx="12" cy="14.5" r="4.5" />
            <path d="M7.5 5.25h.01M10.5 5.25h.01" />
          </>
        );
      case "meals":
        return (
          <>
            <path d="M4 3v5.5a2.5 2.5 0 0 0 5 0V3M6.5 3v18" />
            <path d="M15 3v18M15 3c3 2 4.5 5 4.5 8H15" />
          </>
        );
      case "notifications":
        return (
          <>
            <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M10 21h4" />
          </>
        );
      case "settings":
        return (
          <>
            <path d="M4 7h7M15 7h5M4 17h3M11 17h9" />
            <circle cx="13" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </>
        );
    }
  })();

  return (
    <svg
      className="workspace-navigation-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {icon}
    </svg>
  );
}

function PageIntro({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <section className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

function surfaceBadge(
  kind: ReturnType<typeof resolveSurface>["kind"],
  desktopAuthState: DesktopAuthState | "loading",
  desktopHealth: DesktopAuthStatus["health"],
  companionAuthState: AttendanceAuthState,
): {
  readonly label: string;
  readonly tone: "neutral" | "success" | "warning";
} {
  if (kind === "public") {
    return { label: "누구나 이용 가능", tone: "neutral" };
  }
  if (kind === "desktop") {
    if (desktopAuthState === "connected" && desktopHealth === "online") {
      return { label: "LMS 연결됨", tone: "success" };
    }
    if (desktopAuthState === "loading") {
      return { label: "상태 확인 중", tone: "neutral" };
    }
    return { label: "LMS 확인 필요", tone: "warning" };
  }
  if (companionAuthState === "loaded") {
    return { label: "휴대폰 연결됨", tone: "success" };
  }
  if (companionAuthState === "loading") {
    return { label: "상태 확인 중", tone: "neutral" };
  }
  return { label: "PC 연결 필요", tone: "warning" };
}
