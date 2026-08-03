import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  getPublicLaundry,
  getPublicMeals,
  type CampusEnvelope,
  type LaundrySnapshot,
  type MealsSnapshot,
} from "../campus-client";
import { PublicInformation } from "./PublicInformation";

vi.mock("../campus-client", () => ({
  getPublicLaundry: vi.fn(),
  getPublicMeals: vi.fn(),
}));

const laundry: CampusEnvelope<LaundrySnapshot> = {
  kind: "laundry",
  etag: "\"laundry\"",
  savedAtEpochMs: Date.parse("2026-07-31T04:33:30.000Z"),
  lastCheckedAtEpochMs: Date.parse("2026-07-31T04:34:00.000Z"),
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
    machines: Array.from({ length: 9 }, (_, index) => ({
      id: `워시타워_${index + 1}`,
      washer: {
        appliance: "washer" as const,
        operationalStatus: "IDLE",
        remainingMinutes: 0,
        sessionId: null,
        projection: {
          remainingMinutes: 0,
          status: "IDLE",
          estimated: false,
        },
      },
      dryer:
        index === 0
          ? {
              appliance: "dryer" as const,
              operationalStatus: "RUNNING",
              remainingMinutes: 18,
              sessionId: "dryer-1",
              projection: {
                remainingMinutes: 15,
                status: "ESTIMATED_RUNNING",
                estimated: true,
              },
            }
          : {
              appliance: "dryer" as const,
              operationalStatus: "IDLE",
              remainingMinutes: 0,
              sessionId: null,
              projection: {
                remainingMinutes: 0,
                status: "IDLE",
                estimated: false,
              },
            },
    })),
  },
};

const meals: CampusEnvelope<MealsSnapshot> = {
  kind: "meals",
  etag: "\"meals\"",
  savedAtEpochMs: Date.parse("2026-07-31T04:33:30.000Z"),
  lastCheckedAtEpochMs: Date.parse("2026-07-31T04:34:00.000Z"),
  stale: false,
  lastError: null,
  data: {
    asOf: "2026-07-31T04:33:30.000Z",
    lastCheckedAt: "2026-07-31T04:30:13.220Z",
    data: {
      dailyMenus: [
        {
          id: "menu-1",
          kind: "DAILY_MENU",
          title: "7월 31일(금) 중식 메뉴",
          text: "살얼음오징어물회, 추가밥, 돼지고기육전",
          publishedAt: "2026-07-31T02:32:56.000Z",
          permalink: "https://pf.kakao.com/_xhzNjn/114130545",
        },
      ],
      pinnedMenus: [],
      recentMenus: [],
    },
  },
};

describe("public campus information", () => {
  beforeEach(() => {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
    vi.mocked(getPublicLaundry).mockReset();
    vi.mocked(getPublicMeals).mockReset();
    vi.mocked(getPublicLaundry).mockResolvedValue(laundry);
    vi.mocked(getPublicMeals).mockResolvedValue(meals);
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-31T04:34:30.000Z"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders live meal text and projected laundry availability", async () => {
    render(<PublicInformation />);

    expect(await screen.findByText("예상 7회")).toBeVisible();
    expect(screen.getByText("예상 4회")).toBeVisible();
    expect(
      screen.getByRole("table", {
        name: "워시타워 번호별 건조기와 세탁기 상태",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("list", { name: "세탁실 구역 색상" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /산출 기준 보기/ }),
    );
    expect(screen.getByText(/실제 상황과 다를 수 있어요/)).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "기기별 상세 상태" }),
    );
    expect(screen.getByText("워시타워 1")).toBeVisible();
    expect(screen.getAllByText("사용 가능").length).toBeGreaterThan(0);
    expect(screen.getByText("15분 남음")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "생활 정보" }),
    ).not.toHaveAttribute("aria-live");

    showMeals();
    expect(await screen.findByText(/살얼음오징어물회/)).toBeVisible();
    expect(screen.queryByText(/더미/)).not.toBeInTheDocument();
    expect(document.querySelector("#meals")).toBeVisible();
    expect(screen.getByText(/저장된 데이터 ·/)).toBeVisible();
    expect(screen.getByText(/마지막 확인 ·/)).toBeVisible();
  });

  it("selects meals on initial render when the hash is #meals", async () => {
    window.history.replaceState(null, "", "#meals");

    render(<PublicInformation />);

    expect(
      screen.getByRole("tab", { name: "급식" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/살얼음오징어물회/)).toBeVisible();
  });

  it("reacts to hash changes and defaults unknown hashes to laundry", async () => {
    window.history.replaceState(null, "", "#unknown");
    render(<PublicInformation />);

    expect(
      screen.getByRole("tab", { name: "세탁" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText("예상 7회")).toBeVisible();

    act(() => {
      window.history.replaceState(null, "", "#meals");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });

    expect(
      screen.getByRole("tab", { name: "급식" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByText(/살얼음오징어물회/)).toBeVisible();
  });

  it("updates the hash when a 생활 정보 tab is selected", async () => {
    render(<PublicInformation />);
    await screen.findByText("예상 7회");

    fireEvent.click(screen.getByRole("tab", { name: "급식" }));
    expect(window.location.hash).toBe("#meals");

    fireEvent.click(screen.getByRole("tab", { name: "세탁" }));
    expect(window.location.hash).toBe("#laundry");
  });

  it("marks last-good data as stale without hiding it", async () => {
    vi.mocked(getPublicLaundry).mockResolvedValue({
      ...laundry,
      stale: true,
      lastError: "UPSTREAM_TIMEOUT",
    });

    render(<PublicInformation />);

    expect(await screen.findByText("업데이트 지연")).toBeVisible();
    expect(screen.getAllByText("산출 불가")).toHaveLength(2);
  });

  it("isolates an unavailable meal source from working laundry data", async () => {
    vi.mocked(getPublicMeals).mockRejectedValue(new Error("HTTP_503"));

    render(<PublicInformation />);

    showMeals();
    expect(
      await screen.findByText("현재 식단을 불러올 수 없어요."),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "급식 다시 확인" }),
    ).toBeVisible();
  });

  it("keeps last-good data and offers retry when a periodic refresh fails", async () => {
    vi.useFakeTimers();
    render(<PublicInformation />);
    showMeals();

    await settlePromises();
    expect(screen.getByText(/살얼음오징어물회/)).toBeVisible();

    vi.mocked(getPublicMeals).mockRejectedValueOnce(
      new Error("HTTP_503"),
    );
    await act(async () => {
      vi.advanceTimersByTime(5 * 60 * 1_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText(/살얼음오징어물회/)).toBeVisible();
    expect(
      screen.getByText(
        "새 정보를 확인하지 못해 마지막으로 저장한 내용을 보여드려요.",
      ),
    ).toBeVisible();
    const retry = screen.getByRole("button", {
      name: "급식 다시 확인",
    });
    expect(retry).toBeVisible();

    fireEvent.click(retry);
    await settlePromises();

    expect(
      screen.queryByText(
        "새 정보를 확인하지 못해 마지막으로 저장한 내용을 보여드려요.",
      ),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/살얼음오징어물회/)).toBeVisible();
  });

  it("keeps machine details but withdraws estimates when laundry refresh fails", async () => {
    vi.useFakeTimers();
    render(<PublicInformation />);
    await settlePromises();
    expect(screen.getByText("예상 7회")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "기기별 상세 상태" }),
    );

    vi.mocked(getPublicLaundry).mockRejectedValueOnce(
      new Error("HTTP_503"),
    );
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getAllByText("산출 불가")).toHaveLength(2);
    expect(screen.getByText("워시타워 1")).toBeVisible();
    expect(
      screen.getByText(
        "새 정보를 확인하지 못해 마지막으로 저장한 내용을 보여드려요.",
      ),
    ).toBeVisible();
  });

  it("shows an unknown state instead of zero capacity for no reported appliances", async () => {
    vi.mocked(getPublicLaundry).mockResolvedValue({
      ...laundry,
      data: {
        ...laundry.data!,
        machines: [],
      },
    });

    render(<PublicInformation />);

    expect(
      await screen.findByText(
        "확인된 기기가 없어 사용 가능 수를 알 수 없어요.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("산출 불가")).toHaveLength(2);
    expect(
      screen.getByLabelText("사용 가능 수 미확인"),
    ).toBeVisible();
    expect(screen.queryByText("0개")).not.toBeInTheDocument();
  });

  it("marks only the affected access group unavailable for partial machine data", async () => {
    vi.mocked(getPublicLaundry).mockResolvedValue({
      ...laundry,
      data: {
        ...laundry.data!,
        machines: laundry.data!.machines.map((machine, index) =>
          index === 7 ? { ...machine, dryer: null } : machine,
        ),
      },
    });

    render(<PublicInformation />);

    expect(await screen.findByText("예상 7회")).toBeVisible();
    expect(screen.getByText("산출 불가")).toBeVisible();
    expect(screen.queryByText("예상 3회")).not.toBeInTheDocument();
  });

  it("announces only changing refresh status, not the whole data grid", async () => {
    render(<PublicInformation />);

    showMeals();
    expect(await screen.findByText(/살얼음오징어물회/)).toBeVisible();
    expect(
      screen.getByRole("region", { name: "생활 정보" }),
    ).not.toHaveAttribute("aria-live");
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("refreshes laundry every 30 seconds and meals every 5 minutes", async () => {
    vi.useFakeTimers();
    render(<PublicInformation />);
    await settlePromises();

    expect(getPublicLaundry).toHaveBeenCalledTimes(1);
    expect(getPublicMeals).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getPublicLaundry).toHaveBeenCalledTimes(2);
    expect(getPublicMeals).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    });
    expect(getPublicLaundry).toHaveBeenCalledTimes(11);
    expect(getPublicMeals).toHaveBeenCalledTimes(2);
  });

  it("keeps previous dates out of the other-today menu list", async () => {
    vi.mocked(getPublicMeals).mockResolvedValue({
      ...meals,
      data: {
        ...meals.data!,
        data: {
          ...meals.data!.data,
          dailyMenus: [
            ...meals.data!.data.dailyMenus,
            {
              id: "menu-yesterday",
              kind: "DAILY_MENU",
              title: "7월 30일(목) 석식 메뉴",
              text: "어제 저녁",
              publishedAt: "2026-07-30T08:00:00.000Z",
              permalink: null,
            },
            {
              id: "menu-today-dinner",
              kind: "DAILY_MENU",
              title: "2026년 7월 31일 석식 메뉴",
              text: "오늘 저녁",
              publishedAt: "2026-07-31T08:00:00.000Z",
              permalink: null,
            },
          ],
        },
      },
    });

    render(<PublicInformation />);

    showMeals();
    expect(await screen.findByText("오늘 저녁")).toBeVisible();
    const alternatives = screen.getByLabelText("다른 오늘 메뉴");
    expect(alternatives).toHaveTextContent("오늘 저녁");
    expect(alternatives).not.toHaveTextContent("어제 저녁");
    expect(screen.getByText("최근 식단 보기")).toBeInTheDocument();
  });

  it("does not promote yesterday or a pinned weekly post as today's meal", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-08-01T05:00:00.000Z"),
    );
    vi.mocked(getPublicMeals).mockResolvedValue({
      ...meals,
      data: {
        ...meals.data!,
        data: {
          dailyMenus: meals.data!.data.dailyMenus,
          pinnedMenus: [
            {
              id: "weekly",
              kind: "PINNED",
              title: "이번 주 식단",
              text: "주간 메뉴",
              publishedAt: "2026-07-27T00:00:00.000Z",
              permalink: null,
            },
          ],
          recentMenus: [],
        },
      },
    });

    render(<PublicInformation />);

    showMeals();
    expect(
      await screen.findByText("오늘 식단이 아직 게시되지 않았어요."),
    ).toBeVisible();
    expect(screen.queryByLabelText("다른 오늘 메뉴")).not.toBeInTheDocument();
    expect(screen.queryByText("주간 메뉴")).not.toBeInTheDocument();
  });
});

async function settlePromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function showMeals(): void {
  fireEvent.click(screen.getByRole("tab", { name: "급식" }));
}
