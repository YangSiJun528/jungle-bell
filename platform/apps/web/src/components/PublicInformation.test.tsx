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
    machines: [
      {
        id: "워시타워_1",
        washer: {
          appliance: "washer",
          operationalStatus: "IDLE",
          remainingMinutes: 0,
          sessionId: "washer-1",
          projection: {
            remainingMinutes: 0,
            status: "IDLE",
            estimated: false,
          },
        },
        dryer: {
          appliance: "dryer",
          operationalStatus: "RUNNING",
          remainingMinutes: 18,
          sessionId: "dryer-1",
          projection: {
            remainingMinutes: 15,
            status: "ESTIMATED_RUNNING",
            estimated: true,
          },
        },
      },
    ],
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
    vi.mocked(getPublicLaundry).mockReset();
    vi.mocked(getPublicMeals).mockReset();
    vi.mocked(getPublicLaundry).mockResolvedValue(laundry);
    vi.mocked(getPublicMeals).mockResolvedValue(meals);
    vi.spyOn(Date, "now").mockReturnValue(
      Date.parse("2026-07-31T05:00:00.000Z"),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders live meal text and projected laundry availability", async () => {
    render(<PublicInformation />);

    expect(await screen.findByText("1")).toBeVisible();
    expect(screen.getByText("대 사용 가능")).toBeVisible();
    expect(screen.getByText("워시타워 1")).toBeVisible();
    expect(screen.getByText("사용 가능")).toBeVisible();
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

  it("marks last-good data as stale without hiding it", async () => {
    vi.mocked(getPublicLaundry).mockResolvedValue({
      ...laundry,
      stale: true,
      lastError: "UPSTREAM_TIMEOUT",
    });

    render(<PublicInformation />);

    expect(await screen.findByText("업데이트 지연")).toBeVisible();
    expect(screen.getByText("대 사용 가능")).toBeVisible();
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
    expect(
      screen.getByLabelText("사용 가능 수 미확인"),
    ).toBeVisible();
    expect(screen.queryByText("0개")).not.toBeInTheDocument();
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
