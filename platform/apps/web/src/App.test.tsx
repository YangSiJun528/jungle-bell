import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCompanionAttendanceDashboard,
  getDesktopAttendanceDashboard,
  getDesktopAuthStatus,
  getVapidPublicKey,
  registerPushSubscription,
  sendServerPushTest,
  type AttendanceDashboardResult,
  type AttendanceDto,
} from "./api-client";
import { App } from "./App";
import { sendLocalTestNotification } from "./notifications";
import { getMealRule } from "./personal-client";
import { readStoredPushSubscriptionId } from "./push-local-state";

vi.mock("./desktop-bridge", () => ({
  clearLocalDesktopSession: vi.fn(),
  startLmsLogin: vi.fn(),
}));

vi.mock("./components/MobilePairing", () => ({
  MobilePairing: ({
    manualMode,
  }: {
    readonly manualMode?: boolean;
  }) => (
    <section data-testid="mobile-pairing">
      {manualMode ? "PC 앱의 연결 코드 입력" : "QR 연결"}
    </section>
  ),
}));

vi.mock("./components/MobileSessionManager", () => ({
  MobileSessionManager: ({ mode }: { readonly mode: string }) => (
    <section>{mode === "desktop" ? "모바일 기기 관리" : "계정 연결"}</section>
  ),
}));

vi.mock("./notifications", () => ({
  sendLocalTestNotification: vi.fn(),
}));

vi.mock("./push-local-state", () => ({
  clearBrowserPushState: vi.fn(),
  readStoredPushSubscriptionId: vi.fn(),
  storePushSubscriptionId: vi.fn(),
}));

vi.mock("./campus-client", () => ({
  getPublicLaundry: vi.fn(async () => ({
    kind: "laundry",
    data: null,
    etag: null,
    savedAtEpochMs: null,
    lastCheckedAtEpochMs: null,
    stale: true,
    lastError: "NOT_READY",
  })),
  getPublicMeals: vi.fn(async () => ({
    kind: "meals",
    data: null,
    etag: null,
    savedAtEpochMs: null,
    lastCheckedAtEpochMs: null,
    stale: true,
    lastError: "NOT_READY",
  })),
}));

vi.mock("./personal-client", () => ({
  cancelLaundryWatch: vi.fn(),
  createLaundryWatch: vi.fn(),
  getAttendanceRule: vi.fn(async () => ({
    enabled: false,
    morning: false,
    evening: false,
    updatedAtEpochMs: 0,
  })),
  getLaundryQueue: vi.fn(async () => []),
  getLaundryWatches: vi.fn(async () => []),
  getMealRule: vi.fn(async () => ({
    enabled: true,
    breakfast: false,
    lunch: true,
    dinner: true,
    updatedAtEpochMs: 1_775_000_000_000,
  })),
  joinLaundryQueue: vi.fn(),
  leaveLaundryQueue: vi.fn(),
  putAttendanceRule: vi.fn(),
  putMealRule: vi.fn(),
}));

vi.mock("./api-client", () => ({
  approveMobilePairing: vi.fn(),
  createMobilePairing: vi.fn(),
  disconnectLms: vi.fn(),
  getCompanionAttendanceDashboard: vi.fn(),
  getDesktopAttendanceDashboard: vi.fn(),
  getDesktopAuthStatus: vi.fn(async () => ({
    state: "disconnected",
    desktopId: null,
    lastVerifiedAt: null,
    lastSeenAt: null,
    health: null,
  })),
  getMobilePairingStatus: vi.fn(),
  getVapidPublicKey: vi.fn(),
  registerPushSubscription: vi.fn(),
  revokePushSubscription: vi.fn(),
  sendServerPushTest: vi.fn(),
}));

const unavailableAttendance: AttendanceDto = {
  status: "unavailable",
  freshness: "missing",
  lastSyncedAt: null,
  snapshot: null,
};

const activeAttendance: AttendanceDto = {
  status: "available",
  freshness: "fresh",
  lastSyncedAt: "2026-07-30T01:02:03.000Z",
  snapshot: {
    attendanceDate: "2026-07-30",
    cohortId: "cohort-7",
    cohortStatus: "active",
    cohortStartDate: "2026-07-01",
    cohortEndDate: "2026-08-01",
    morningChecked: true,
    eveningChecked: false,
    collectedAt: "2026-07-30T01:02:03.000Z",
    sourceDeviceId: "desktop-1",
    version: 4,
  },
};

const connectedDevices = [
  {
    id: "desktop-1",
    lastVerifiedAt: "2026-07-30T00:00:00.000Z",
    lastSeenAt: "2026-07-30T01:02:03.000Z",
    lmsSessionState: "connected",
    health: "online",
    appVersion: "0.1.0",
  },
] as const;

describe("surface boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDesktopAttendanceDashboard).mockReset();
    vi.mocked(getCompanionAttendanceDashboard).mockReset();
    vi.mocked(getDesktopAuthStatus).mockReset();
    vi.mocked(sendLocalTestNotification).mockReset();
    vi.mocked(sendLocalTestNotification).mockResolvedValue("sent");
    vi.mocked(sendServerPushTest).mockReset();
    vi.mocked(sendServerPushTest).mockResolvedValue({
      results: [{ status: "delivered" }],
    });
    vi.mocked(readStoredPushSubscriptionId).mockReset();
    vi.mocked(readStoredPushSubscriptionId).mockReturnValue(null);
    vi.mocked(getDesktopAuthStatus).mockResolvedValue({
      state: "disconnected",
      desktopId: null,
      lastVerifiedAt: null,
      lastSeenAt: null,
      health: null,
    });
    vi.mocked(getDesktopAttendanceDashboard).mockResolvedValue({
      state: "auth-required",
    });
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "auth-required",
    });
  });

  it("shows meals and laundry but no personal features on the public web", () => {
    render(<App initialPath="/" tauri={false} />);

    expect(screen.getByRole("heading", { name: "워시타워" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "급식" }));
    expect(screen.getByRole("heading", { name: "오늘의 식단" })).toBeVisible();
    expect(screen.queryByText("출석 상태")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "알림" })).not.toBeInTheDocument();
    expect(screen.queryByText("로그인 상태")).not.toBeInTheDocument();
    expect(getDesktopAttendanceDashboard).not.toHaveBeenCalled();
    expect(getCompanionAttendanceDashboard).not.toHaveBeenCalled();
  });

  it("uses the desktop dashboard route in the desktop shell", async () => {
    vi.mocked(getDesktopAuthStatus).mockResolvedValue({
      state: "connected",
      desktopId: "desktop-1",
      lastVerifiedAt: "2026-07-30T00:00:00.000Z",
      lastSeenAt: "2026-07-30T01:02:03.000Z",
      health: "online",
    });
    render(<App initialPath="/desktop" tauri />);

    expect(
      await screen.findByRole("button", { name: "출석 페이지 열기" }),
    ).toBeVisible();
    expect(screen.getByText("로그인 상태")).toBeVisible();
    expect(await screen.findByText("PC 연결이 필요해요")).toBeVisible();
    expect(document.querySelector("#attendance")).toBeVisible();

    await openWorkspaceTab("기기");
    expect(screen.getByRole("heading", { name: "휴대폰 연결" })).toBeVisible();
    expect(screen.getByText("모바일 기기 관리")).toBeVisible();

    await openWorkspaceTab("알림");
    expect(screen.getByRole("heading", { name: "알림 설정" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "알림 받기" })).toBeVisible();
    expect(screen.queryByText(/helper/i)).not.toBeInTheDocument();
    expect(getDesktopAttendanceDashboard).toHaveBeenCalled();
    expect(getCompanionAttendanceDashboard).not.toHaveBeenCalled();
  });

  it("does not request private preferences on a fresh desktop before LMS login", async () => {
    render(<App initialPath="/desktop" tauri />);

    expect(
      screen.getByRole("button", { name: "LMS 로그인" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "알림 설정" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("LMS 연결 안 됨")).toBeVisible();
  });

  it("shows manual pairing instead of private controls on an unauthenticated companion", async () => {
    render(<App initialPath="/app" tauri={false} />);

    expect(screen.getByText("출석 상태")).toBeVisible();
    expect(screen.queryByText("로그인 상태")).not.toBeInTheDocument();
    expect(getCompanionAttendanceDashboard).toHaveBeenCalledOnce();
    expect(getDesktopAttendanceDashboard).not.toHaveBeenCalled();
    expect(await screen.findByText("PC 연결이 필요해요")).toBeVisible();
    expect(screen.getByText("PC 앱의 연결 코드 입력")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "알림 설정" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "알림" })).toBeDisabled();
    expect(getMealRule).not.toHaveBeenCalled();
    expect(sendLocalTestNotification).not.toHaveBeenCalled();
  });

  it("shows private controls only after the companion session is authenticated", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    await openWorkspaceTab("알림");
    expect(screen.getByRole("heading", { name: "알림 설정" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "알림 받기" })).toBeVisible();
    expect(screen.queryByTestId("mobile-pairing")).not.toBeInTheDocument();
  });

  it("shows loading and then active cohort, morning, evening, and sync states", async () => {
    let resolveDashboard:
      | ((value: AttendanceDashboardResult) => void)
      | undefined;
    vi.mocked(getCompanionAttendanceDashboard).mockReturnValue(
      new Promise((resolve) => {
        resolveDashboard = resolve;
      }),
    );
    render(<App initialPath="/app" tauri={false} />);

    expect(screen.getByText("출석 정보를 확인하고 있어요")).toBeVisible();

    await act(async () => {
      resolveDashboard?.({
        state: "loaded",
        attendance: activeAttendance,
        devices: connectedDevices,
      });
    });

    expect(screen.getByText("학습 기간")).toBeVisible();
    expect(screen.getByText("오전 출석 완료")).toBeVisible();
    expect(screen.getByText("오후 출석 미완료")).toBeVisible();
    expect(screen.getByText("7월 1일–8월 1일")).toBeVisible();
    expect(screen.getByText(/마지막 동기화/)).toBeVisible();
  });

  it("labels an old attendance snapshot with its date instead of calling it today", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: {
        ...activeAttendance,
        snapshot: {
          ...activeAttendance.snapshot,
          attendanceDate: "2000-01-01",
        },
      },
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    expect(
      await screen.findByLabelText("2000년 1월 1일 출석 상태"),
    ).toBeVisible();
    expect(screen.queryByLabelText("오늘 출석 상태")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "지난 날짜의 출석 정보예요. 오늘 출석과 혼동하지 않도록 확인해 주세요.",
      ),
    ).toBeVisible();
  });

  it("uses the today label only when the attendance date matches Seoul time", async () => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const part = (type: "year" | "month" | "day") =>
      parts.find((candidate) => candidate.type === type)?.value ?? "";
    const today = `${part("year")}-${part("month")}-${part("day")}`;
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: {
        ...activeAttendance,
        snapshot: {
          ...activeAttendance.snapshot,
          attendanceDate: today,
        },
      },
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    expect(await screen.findByLabelText("오늘 출석 상태")).toBeVisible();
    expect(
      screen.queryByText(/오늘 출석으로 판단하지 마십시오/),
    ).not.toBeInTheDocument();
  });

  it("warns when the attendance snapshot date is in the future", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: {
        ...activeAttendance,
        snapshot: {
          ...activeAttendance.snapshot,
          attendanceDate: "2999-12-31",
        },
      },
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    expect(
      await screen.findByLabelText("2999년 12월 31일 출석 상태"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "출석 날짜가 오늘보다 뒤예요. PC의 날짜와 동기화 상태를 확인해 주세요.",
      ),
    ).toBeVisible();
  });

  it("distinguishes a local display test from a connected server Push test", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    await openWorkspaceTab("알림");
    const localTest = await screen.findByRole("button", {
      name: "기기 알림 테스트",
    });
    fireEvent.click(localTest);
    expect(
      await screen.findByText(
        "이 기기에 테스트 알림을 표시했어요. 원격 알림 연결은 아직 확인하지 않았어요.",
      ),
    ).toBeVisible();
    expect(sendLocalTestNotification).toHaveBeenCalledWith("web-push");
  });

  it("reports a rejected local notification and restores the test button", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: connectedDevices,
    });
    vi.mocked(sendLocalTestNotification).mockRejectedValueOnce(
      new Error("service worker unavailable"),
    );

    render(<App initialPath="/app" tauri={false} />);

    await openWorkspaceTab("알림");
    const localTest = await screen.findByRole("button", {
      name: "기기 알림 테스트",
    });
    fireEvent.click(localTest);

    expect(
      await screen.findByText("테스트 알림을 표시하지 못했어요."),
    ).toBeVisible();
    expect(localTest).toBeEnabled();
  });

  it("labels the test as server Push only when a subscription is registered", async () => {
    const subscriptionId = `jbps_${"a".repeat(64)}`;
    vi.mocked(readStoredPushSubscriptionId).mockReturnValue(subscriptionId);
    vi.mocked(registerPushSubscription).mockResolvedValue({
      subscriptionId,
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: {
            getSubscription: vi.fn(async () => ({
              toJSON: () => ({
                endpoint: "https://push.example.com/subscription",
                expirationTime: null,
                keys: {
                  auth: "a".repeat(24),
                  p256dh: "b".repeat(88),
                },
              }),
            })),
          },
        })),
      },
    });
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    await openWorkspaceTab("알림");
    expect(
      await screen.findByRole("button", { name: "알림 보내보기" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "알림 보내보기" }),
    );
    expect(
      await screen.findByText(
        "이 기기로 테스트 알림을 보냈어요.",
      ),
    ).toBeVisible();
    expect(sendServerPushTest).toHaveBeenCalledOnce();
    expect(sendLocalTestNotification).not.toHaveBeenCalled();
  });

  it("shows the unavailable state returned by the collector", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    expect(
      await screen.findByText(
        "아직 PC에서 확인한 출석 정보가 없어요.",
      ),
    ).toBeVisible();
  });

  it("surfaces a local PC authentication failure on the companion", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: [
        {
          ...connectedDevices[0],
          lmsSessionState: "login-required",
          health: "offline",
        },
      ],
    });

    render(<App initialPath="/app" tauri={false} />);

    expect(
      await screen.findByText(
        "PC의 LMS 로그인이 만료됐어요. PC 앱에서 다시 로그인해 주세요.",
      ),
    ).toBeVisible();
  });

  it("shows every PC state even when another PC is still connected", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: activeAttendance,
      devices: [
        connectedDevices[0],
        {
          ...connectedDevices[0],
          id: "desktop-2",
          lmsSessionState: "login-required",
          health: "offline",
        },
      ],
    });

    render(<App initialPath="/app" tauri={false} />);

    expect(
      await screen.findByRole("list", { name: "출석 확인 PC 상태" }),
    ).toBeVisible();
    expect(screen.getByText("PC 1")).toBeVisible();
    expect(screen.getByText("PC 2")).toBeVisible();
    expect(
      screen.getByText("1대의 PC에서 LMS 로그인을 다시 확인해야 해요."),
    ).toBeVisible();
  });

  it("separates an API error from authentication and unavailable states", async () => {
    vi.mocked(getCompanionAttendanceDashboard).mockRejectedValue(
      new Error("API_RESPONSE_INVALID"),
    );

    render(<App initialPath="/app" tauri={false} />);

    expect(
      await screen.findByText("출석 정보를 불러오지 못했어요"),
    ).toBeVisible();
  });

  it("recovers an opted-in Push subscription after browser rotation", async () => {
    const previousId = `jbps_${"c".repeat(64)}`;
    const recoveredId = `jbps_${"d".repeat(64)}`;
    const keyBytes = new Uint8Array(65);
    keyBytes[0] = 4;
    keyBytes.fill(9, 1);
    let binary = "";
    for (const byte of keyBytes) {
      binary += String.fromCharCode(byte);
    }
    const publicKey = btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
    const recoveredSubscription = {
      endpoint: "https://push.example.com/recovered",
      expirationTime: null,
      getKey: vi.fn(),
      options: {
        applicationServerKey: keyBytes.buffer,
        userVisibleOnly: true,
      },
      subscribe: vi.fn(),
      toJSON: () => ({
        endpoint: "https://push.example.com/recovered",
        expirationTime: null,
        keys: {
          auth: "a".repeat(24),
          p256dh: "b".repeat(88),
        },
      }),
      unsubscribe: vi.fn(async () => true),
    } as unknown as PushSubscription;
    const subscribe = vi.fn(async () => recoveredSubscription);
    const registration = {
      pushManager: {
        getSubscription: vi.fn(async () => null),
        subscribe,
      },
    };
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: vi.fn(),
        getRegistration: vi.fn(async () => registration),
        removeEventListener: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "isSecureContext", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(globalThis, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true })),
    });
    Object.defineProperty(globalThis, "PushManager", {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: vi.fn(async () => "granted"),
      },
    });
    vi.mocked(readStoredPushSubscriptionId).mockReturnValue(previousId);
    vi.mocked(getVapidPublicKey).mockResolvedValue({ publicKey });
    vi.mocked(registerPushSubscription).mockResolvedValue({
      subscriptionId: recoveredId,
    });
    vi.mocked(getCompanionAttendanceDashboard).mockResolvedValue({
      state: "loaded",
      attendance: unavailableAttendance,
      devices: connectedDevices,
    });

    render(<App initialPath="/app" tauri={false} />);

    await openWorkspaceTab("알림");
    expect(
      await screen.findByText(
        "만료된 브라우저 알림을 다시 연결했어요.",
      ),
    ).toBeVisible();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(registerPushSubscription).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://push.example.com/recovered",
      }),
    );
  });
});

async function openWorkspaceTab(name: "홈" | "생활" | "알림" | "기기") {
  const tab = await screen.findByRole("tab", { name });
  await waitFor(() => expect(tab).toBeEnabled());
  fireEvent.click(tab);
}
