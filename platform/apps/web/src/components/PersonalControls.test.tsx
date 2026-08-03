import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { getPublicLaundry } from "../campus-client";
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
  type LaundryQueueEntryDto,
  type LaundryWatchDto,
  type MealRuleDto,
} from "../personal-client";
import { PersonalControls } from "./PersonalControls";

vi.mock("../campus-client", () => ({
  getPublicLaundry: vi.fn(),
}));

vi.mock("../personal-client", () => ({
  cancelLaundryWatch: vi.fn(),
  createLaundryWatch: vi.fn(),
  getAttendanceRule: vi.fn(),
  getLaundryQueue: vi.fn(),
  getLaundryWatches: vi.fn(),
  getMealRule: vi.fn(),
  joinLaundryQueue: vi.fn(),
  leaveLaundryQueue: vi.fn(),
  putAttendanceRule: vi.fn(),
  putMealRule: vi.fn(),
}));

const rule = {
  enabled: true,
  breakfast: false,
  lunch: true,
  dinner: true,
  updatedAtEpochMs: 1_775_000_000_000,
};

const runningWatch: LaundryWatchDto = {
  id: "watch-1",
  machineId: "워시타워_2",
  appliance: "washer",
  sessionId: "washer-session-42",
  notifyBeforeMinutes: 10,
  notifyWhenAvailable: true,
  status: "active",
  createdAtEpochMs: 1_775_000_000_000,
  updatedAtEpochMs: 1_775_000_000_000,
};

const laundryEnvelope = {
  kind: "laundry",
  etag: "\"laundry\"",
  savedAtEpochMs: 1_775_000_000_000,
  lastCheckedAtEpochMs: 1_775_000_001_000,
  stale: false,
  lastError: null,
  data: {
    asOf: "2026-07-31T04:33:30.000Z",
    final: false,
    quality: {
      collection: "SUCCESS",
      sourceFreshness: "WITHIN_REFRESH_WINDOW",
      lastCheckedAt: "2026-07-31T04:33:00.752Z",
    },
    machines: [
      {
        id: "워시타워_2",
        washer: {
          appliance: "washer",
          operationalStatus: "RUNNING",
          remainingMinutes: 18,
          sessionId: "washer-session-42",
          projection: {
            remainingMinutes: 15,
            status: "ESTIMATED_RUNNING",
            estimated: true,
          },
        },
        dryer: {
          appliance: "dryer",
          operationalStatus: "AVAILABLE",
          remainingMinutes: null,
          sessionId: null,
          projection: {
            remainingMinutes: null,
            status: "AVAILABLE",
            estimated: false,
          },
        },
      },
    ],
  },
} as const;

describe("PersonalControls", () => {
  beforeEach(() => {
    vi.mocked(getMealRule).mockReset();
    vi.mocked(getAttendanceRule).mockReset();
    vi.mocked(getLaundryWatches).mockReset();
    vi.mocked(getLaundryQueue).mockReset();
    vi.mocked(getPublicLaundry).mockReset();
    vi.mocked(putMealRule).mockReset();
    vi.mocked(putAttendanceRule).mockReset();
    vi.mocked(createLaundryWatch).mockReset();
    vi.mocked(cancelLaundryWatch).mockReset();
    vi.mocked(joinLaundryQueue).mockReset();
    vi.mocked(leaveLaundryQueue).mockReset();

    vi.mocked(getMealRule).mockResolvedValue(rule);
    vi.mocked(getAttendanceRule).mockResolvedValue({
      enabled: false,
      morning: false,
      evening: false,
      updatedAtEpochMs: 0,
    });
    vi.mocked(getLaundryWatches).mockResolvedValue([]);
    vi.mocked(getLaundryQueue).mockResolvedValue([]);
    vi.mocked(getPublicLaundry).mockResolvedValue(laundryEnvelope);
    vi.mocked(putMealRule).mockResolvedValue({
      ...rule,
      breakfast: true,
    });
    vi.mocked(putAttendanceRule).mockResolvedValue({
      enabled: true,
      morning: true,
      evening: false,
      updatedAtEpochMs: 1_775_000_000_000,
    });
    vi.mocked(createLaundryWatch).mockResolvedValue(runningWatch);
    vi.mocked(cancelLaundryWatch).mockResolvedValue();
    vi.mocked(joinLaundryQueue).mockResolvedValue({
      id: "queue-1",
      machineId: null,
      appliance: "dryer",
      status: "waiting",
      joinedAtEpochMs: 1_775_000_000_000,
      leftAtEpochMs: null,
      position: 2,
    });
    vi.mocked(leaveLaundryQueue).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("groups each notification domain into its own settings section", async () => {
    render(<PersonalControls />);

    const attendance = await screen.findByRole("group", {
      name: "출석 알림",
    });
    const meal = screen.getByRole("group", { name: "급식 알림" });
    const laundry = screen.getByRole("group", { name: "세탁 알림" });
    const queue = screen.getByRole("group", { name: "자율 대기열" });

    expect(within(attendance).getByLabelText("출석 알림 전체")).toBeVisible();
    expect(within(meal).getByLabelText("급식 알림 전체")).toBeVisible();
    expect(
      within(laundry).getByRole("button", {
        name: "세탁·대기열 새로고침",
      }),
    ).toBeVisible();
    expect(
      within(attendance).queryByRole("button", {
        name: "세탁·대기열 새로고침",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(queue).getByRole("button", { name: "세탁기 대기열 참여" }),
    ).toBeVisible();
  });

  it("tracks dirty meal settings and creates a session-aware watch", async () => {
    render(<PersonalControls />);

    const mealSave = await screen.findByRole("button", {
      name: "급식 알림 저장",
    });
    expect(mealSave).toBeDisabled();

    fireEvent.click(screen.getByLabelText("아침 알림"));
    expect(mealSave).toBeEnabled();
    expect(screen.getAllByText("아직 저장하지 않은 변경이 있어요.")).toHaveLength(
      1,
    );

    fireEvent.click(mealSave);
    await waitFor(() =>
      expect(putMealRule).toHaveBeenCalledWith({
        enabled: true,
        breakfast: true,
        lunch: true,
        dinner: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "급식 알림 저장" }),
      ).toBeDisabled(),
    );

    fireEvent.click(screen.getByRole("button", { name: "세탁 알림 추가" }));
    await waitFor(() =>
      expect(createLaundryWatch).toHaveBeenCalledWith({
        machineId: "워시타워_2",
        appliance: "washer",
        sessionId: "washer-session-42",
        notifyBeforeMinutes: 10,
        notifyWhenAvailable: true,
      }),
    );
    expect(
      await screen.findByText(
        /이 동작 종료 10분 전·완료·사용 가능 전환 알림/,
      ),
    ).toBeVisible();
  });

  it("keeps another section's draft when an older save finishes", async () => {
    const mealSave = deferred<MealRuleDto>();
    vi.mocked(putMealRule).mockReturnValueOnce(mealSave.promise);

    render(<PersonalControls />);

    fireEvent.click(await screen.findByLabelText("아침 알림"));
    fireEvent.click(
      screen.getByRole("button", { name: "급식 알림 저장" }),
    );

    expect(screen.getByLabelText("아침 알림")).toBeDisabled();
    expect(screen.getByLabelText("출석 알림 전체")).toBeEnabled();
    fireEvent.click(screen.getByLabelText("출석 알림 전체"));
    fireEvent.click(screen.getByLabelText("오전 출석 알림"));

    await act(async () => {
      mealSave.resolve({ ...rule, breakfast: true });
      await mealSave.promise;
    });

    expect(screen.getByLabelText("출석 알림 전체")).toBeChecked();
    expect(screen.getByLabelText("오전 출석 알림")).toBeChecked();
    expect(
      screen.getByRole("button", { name: "출석 알림 저장" }),
    ).toBeEnabled();
  });

  it("keeps attendance reminders opt-in and uses the limited reminder policy copy", async () => {
    render(<PersonalControls />);

    const morning = await screen.findByLabelText("오전 출석 알림");
    expect(morning).toBeDisabled();
    expect(
      screen.getByText(/마감 전 지정 시점과 마감 후 한 번/),
    ).toBeVisible();

    fireEvent.click(screen.getByLabelText("출석 알림 전체"));
    fireEvent.click(morning);
    fireEvent.click(
      screen.getByRole("button", { name: "출석 알림 저장" }),
    );

    await waitFor(() =>
      expect(putAttendanceRule).toHaveBeenCalledWith({
        enabled: true,
        morning: true,
        evening: false,
      }),
    );
  });

  it("polls laundry state without resetting unsaved rule drafts", async () => {
    const setIntervalSpy = vi.spyOn(window, "setInterval");

    render(<PersonalControls />);

    fireEvent.click(await screen.findByLabelText("아침 알림"));
    expect(screen.getByLabelText("아침 알림")).toBeChecked();
    const pollingCall = setIntervalSpy.mock.calls.find(
      ([, timeout]) => timeout === 45_000,
    );
    expect(pollingCall).toBeDefined();
    const intervalHandler = pollingCall?.[0] as () => void;

    const refreshedWatch: LaundryWatchDto = {
      id: "watch-refreshed",
      machineId: "워시타워_2",
      appliance: "dryer",
      sessionId: null,
      notifyBeforeMinutes: 0,
      notifyWhenAvailable: true,
      status: "active",
      createdAtEpochMs: 1_775_000_000_000,
      updatedAtEpochMs: 1_775_000_000_000,
    };
    const claimedQueue = queueEntry({
      id: "queue-claimed",
      appliance: "washer",
      status: "claimed",
      position: null,
    });
    vi.mocked(getLaundryWatches).mockResolvedValueOnce([refreshedWatch]);
    vi.mocked(getLaundryQueue).mockResolvedValueOnce([claimedQueue]);

    await act(async () => {
      intervalHandler();
    });

    expect(
      await screen.findByText(/다음 사용 후 사용 가능 전환 알림/),
    ).toBeVisible();
    expect(screen.getByText("세탁기 · 순번 도착 처리됨")).toBeVisible();
    expect(screen.getByLabelText("아침 알림")).toBeChecked();
    expect(
      screen.getByRole("button", { name: "급식 알림 저장" }),
    ).toBeEnabled();
    expect(screen.getByText(/세탁·대기열 최근 갱신/)).toBeVisible();
  });

  it("manually refreshes server state while preserving private controls", async () => {
    render(<PersonalControls />);

    fireEvent.click(await screen.findByLabelText("아침 알림"));
    vi.mocked(getLaundryQueue).mockResolvedValueOnce([
      queueEntry({
        id: "queue-expired",
        appliance: "dryer",
        status: "expired",
        position: null,
      }),
    ]);

    fireEvent.click(
      screen.getByRole("button", { name: "세탁·대기열 새로고침" }),
    );

    expect(await screen.findByText("건조기 · 대기 만료")).toBeVisible();
    expect(screen.getByLabelText("아침 알림")).toBeChecked();
    expect(
      screen.getByText("세탁 알림과 자율 대기열을 새로 확인했어요."),
    ).toBeVisible();
  });

  it("shows state, remaining time, and the exact watch condition in target labels", async () => {
    render(<PersonalControls />);

    await openLaundryOptions();
    expect(
      await screen.findByRole("option", {
        name:
          "워시타워 2 · 세탁기 · 사용 중 · 15분 남음 · 알림 조건: 이 동작 종료 10분 전·완료·사용 가능 전환",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", {
        name:
          "워시타워 2 · 건조기 · 사용 가능 · 알림 조건: 다음 사용 후 사용 가능 전환",
      }),
    ).toBeVisible();
  });

  it("treats an idle appliance's retained session id as historical", async () => {
    vi.mocked(getPublicLaundry).mockResolvedValue({
      ...laundryEnvelope,
      data: {
        ...laundryEnvelope.data,
        machines: [
          {
            ...laundryEnvelope.data.machines[0],
            washer: {
              ...laundryEnvelope.data.machines[0].washer,
              operationalStatus: "IDLE",
              remainingMinutes: 0,
              sessionId: "stale-cycle-id",
              projection: {
                remainingMinutes: 0,
                status: "IDLE",
                estimated: false,
              },
            },
          },
        ],
      },
    });

    render(<PersonalControls />);

    await openLaundryOptions();
    const washerOption = await screen.findByRole("option", {
        name:
          "워시타워 2 · 세탁기 · 사용 가능 · 알림 조건: 다음 사용 후 사용 가능 전환",
      });
    expect(washerOption).toBeVisible();
    fireEvent.click(washerOption);
    fireEvent.click(
      screen.getByRole("button", { name: "세탁 알림 추가" }),
    );
    await waitFor(() =>
      expect(createLaundryWatch).toHaveBeenCalledWith({
        machineId: "워시타워_2",
        appliance: "washer",
        sessionId: null,
        notifyBeforeMinutes: 0,
        notifyWhenAvailable: true,
      }),
    );
  });

  it("shows an error cycle as an error while preserving its session watch", async () => {
    vi.mocked(getPublicLaundry).mockResolvedValue({
      ...laundryEnvelope,
      data: {
        ...laundryEnvelope.data,
        machines: [
          {
            ...laundryEnvelope.data.machines[0],
            washer: {
              ...laundryEnvelope.data.machines[0].washer,
              operationalStatus: "ERROR",
              projection: {
                remainingMinutes: null,
                status: "ERROR",
                estimated: false,
              },
            },
          },
        ],
      },
    });

    render(<PersonalControls />);

    await openLaundryOptions();
    const washerOption = await screen.findByRole("option", {
        name:
          "워시타워 2 · 세탁기 · 오류 · 알림 조건: 이 동작 종료 10분 전·완료·사용 가능 전환",
      });
    expect(washerOption).toBeVisible();
    fireEvent.click(washerOption);
    fireEvent.click(
      screen.getByRole("button", { name: "세탁 알림 추가" }),
    );
    await waitFor(() =>
      expect(createLaundryWatch).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "washer-session-42",
          notifyBeforeMinutes: 10,
        }),
      ),
    );
  });

  it("prevents duplicate session and availability watches", async () => {
    const availabilityWatch: LaundryWatchDto = {
      id: "watch-available",
      machineId: "워시타워_2",
      appliance: "dryer",
      sessionId: null,
      notifyBeforeMinutes: 0,
      notifyWhenAvailable: true,
      status: "active",
      createdAtEpochMs: 1_775_000_000_000,
      updatedAtEpochMs: 1_775_000_000_000,
    };
    vi.mocked(getLaundryWatches).mockResolvedValueOnce([
      runningWatch,
      availabilityWatch,
    ]);

    render(<PersonalControls />);

    const addButton = await screen.findByRole("button", {
      name: "이미 등록됨",
    });
    expect(addButton).toBeDisabled();
    fireEvent.click(addButton);
    expect(createLaundryWatch).not.toHaveBeenCalled();

    await openLaundryOptions();
    fireEvent.click(
      screen.getByRole("option", {
        name:
          "워시타워 2 · 건조기 · 사용 가능 · 알림 조건: 다음 사용 후 사용 가능 전환",
      }),
    );
    expect(
      screen.getByRole("button", { name: "이미 등록됨" }),
    ).toBeDisabled();
    expect(createLaundryWatch).not.toHaveBeenCalled();
  });

  it("joins and leaves the explicitly voluntary, non-reservation queue", async () => {
    render(<PersonalControls />);

    expect(
      await screen.findByText(/실제 기기 예약·사용 권한을 만들거나 보장하지 않아요/),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "건조기 대기열 참여" }),
    );
    expect(
      await screen.findByText("건조기 · 대기 중 · 현재 2번째"),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "대기 취소" }));
    await waitFor(() =>
      expect(leaveLaundryQueue).toHaveBeenCalledWith("queue-1"),
    );
  });

  it("renders claimed and expired queue outcomes without cancellation actions", async () => {
    vi.mocked(getLaundryQueue).mockResolvedValueOnce([
      queueEntry({
        id: "claimed",
        appliance: "washer",
        status: "claimed",
        position: null,
      }),
      queueEntry({
        id: "expired",
        appliance: "dryer",
        status: "expired",
        position: null,
      }),
    ]);

    render(<PersonalControls />);

    expect(
      await screen.findByText("세탁기 · 순번 도착 처리됨"),
    ).toBeVisible();
    expect(screen.getByText("건조기 · 대기 만료")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "대기 취소" }),
    ).not.toBeInTheDocument();
  });

  it("shows a contained error when personal state cannot be loaded", async () => {
    vi.mocked(getMealRule).mockRejectedValue(new Error("HTTP_401"));

    render(<PersonalControls />);

    expect(
      await screen.findByText("알림 설정을 불러오지 못했어요."),
    ).toBeVisible();
  });

  it("keeps private controls available when only public laundry data fails", async () => {
    vi.mocked(getPublicLaundry).mockRejectedValueOnce(
      new Error("HTTP_503"),
    );

    render(<PersonalControls />);

    expect(
      await screen.findByRole("group", { name: "출석 알림" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "급식 알림 저장" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("세탁 알림 기기")).toHaveTextContent(
      "기기 정보 없음",
    );
    expect(screen.getByLabelText("세탁 알림 기기")).toBeDisabled();
  });
});

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function queueEntry(input: {
  readonly id: string;
  readonly appliance: "washer" | "dryer";
  readonly status: LaundryQueueEntryDto["status"];
  readonly position: number | null;
}): LaundryQueueEntryDto {
  return {
    id: input.id,
    machineId: null,
    appliance: input.appliance,
    status: input.status,
    joinedAtEpochMs: 1_775_000_000_000,
    leftAtEpochMs:
      input.status === "waiting" ? null : 1_775_000_001_000,
    position: input.position,
  };
}

async function openLaundryOptions(): Promise<void> {
  const select = await screen.findByLabelText("세탁 알림 기기");
  fireEvent.click(select);
}
