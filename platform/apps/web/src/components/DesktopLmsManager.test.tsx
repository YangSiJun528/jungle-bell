import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
  disconnectLms,
  getDesktopAuthStatus,
  type DesktopAuthStatus,
} from "../api-client";
import {
  clearLocalDesktopSession,
  startLmsLogin,
} from "../desktop-bridge";
import { DesktopLmsManager } from "./DesktopLmsManager";

vi.mock("../api-client", () => ({
  disconnectLms: vi.fn(),
  getDesktopAuthStatus: vi.fn(),
}));

vi.mock("../desktop-bridge", () => ({
  clearLocalDesktopSession: vi.fn(),
  startLmsLogin: vi.fn(),
}));

const connectedStatus: DesktopAuthStatus = {
  state: "connected",
  desktopId: "desktop-1",
  lastVerifiedAt: "2026-07-30T09:45:22.000Z",
  lastSeenAt: "2026-07-30T09:46:00.000Z",
  health: "online",
};

const disconnectedStatus: DesktopAuthStatus = {
  state: "disconnected",
  desktopId: null,
  lastVerifiedAt: null,
  lastSeenAt: null,
  health: null,
};

describe("DesktopLmsManager", () => {
  beforeEach(() => {
    vi.mocked(disconnectLms).mockReset();
    vi.mocked(getDesktopAuthStatus).mockReset();
    vi.mocked(startLmsLogin).mockReset();
    vi.mocked(clearLocalDesktopSession).mockReset();
    vi.mocked(getDesktopAuthStatus).mockResolvedValue(connectedStatus);
    vi.mocked(disconnectLms).mockResolvedValue();
    vi.mocked(startLmsLogin).mockResolvedValue();
    vi.mocked(clearLocalDesktopSession).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
    setDocumentHidden(false);
  });

  it("loads non-secret status and drives login through the native command", async () => {
    render(<DesktopLmsManager />);

    expect(await screen.findByText("LMS 연결됨")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "출석 페이지 열기" }),
    );

    await waitFor(() => expect(startLmsLogin).toHaveBeenCalledOnce());
    expect(
      screen.getByText("LMS 출석 페이지를 열었어요."),
    ).toBeVisible();
  });

  it("disconnects through the cookie-auth API and immediately clears the connected UI state", async () => {
    render(<DesktopLmsManager />);

    fireEvent.click(
      await screen.findByRole("button", { name: "LMS 연결 해제" }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "LMS 연결을 해제할까요?",
      }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "연결 해제" }),
    );

    await waitFor(() => expect(disconnectLms).toHaveBeenCalledOnce());
    expect(clearLocalDesktopSession).toHaveBeenCalledOnce();
    expect(screen.getByText("LMS 연결 안 됨")).toBeVisible();
  });

  it("still clears the local LMS session when the server revoke cannot be confirmed", async () => {
    vi.mocked(disconnectLms).mockRejectedValueOnce(
      new Error("SERVER_UNAVAILABLE"),
    );
    render(<DesktopLmsManager />);

    fireEvent.click(
      await screen.findByRole("button", { name: "LMS 연결 해제" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "연결 해제" }),
    );

    await waitFor(() =>
      expect(clearLocalDesktopSession).toHaveBeenCalledOnce(),
    );
    expect(screen.getByText("LMS 연결 안 됨")).toBeVisible();
    expect(
      screen.getByText(
        "이 PC의 LMS 정보는 지웠지만 서버 연결 해제 여부를 확인하지 못했어요.",
      ),
    ).toBeVisible();
  });

  it("does not misreport a transient server error as LMS logout", async () => {
    vi.mocked(getDesktopAuthStatus)
      .mockRejectedValueOnce(new Error("SERVER_UNAVAILABLE"))
      .mockResolvedValueOnce(connectedStatus);
    render(<DesktopLmsManager />);

    expect(await screen.findByText("LMS 상태 확인 지연")).toBeVisible();
    expect(screen.queryByText("LMS 연결 안 됨")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "상태 다시 확인" }),
    );

    expect(await screen.findByText("LMS 연결됨")).toBeVisible();
  });

  it("polls at most once per minute while visible and stops completely while hidden", async () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    render(<DesktopLmsManager />);

    await flushPromises();
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(59_999);
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(2);

    setDocumentHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(2);

    setDocumentHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(3);
  });

  it("does not start a status request until an initially hidden document becomes visible", async () => {
    vi.useFakeTimers();
    setDocumentHidden(true);
    render(<DesktopLmsManager />);
    await flushPromises();

    await act(async () => {
      vi.advanceTimersByTime(5 * 60_000);
    });
    expect(getDesktopAuthStatus).not.toHaveBeenCalled();

    setDocumentHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledOnce();
  });

  it("uses two-second polling only after login and returns to the minute cadence on success", async () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    vi.mocked(getDesktopAuthStatus)
      .mockResolvedValueOnce(disconnectedStatus)
      .mockResolvedValueOnce(disconnectedStatus)
      .mockResolvedValue({
        ...connectedStatus,
        lastVerifiedAt: "2026-07-30T09:50:00.000Z",
      });
    render(<DesktopLmsManager />);
    await flushPromises();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "LMS 로그인" }),
      );
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(2);

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(3);
    expect(screen.getByText("LMS 연결됨")).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(59_999);
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(3);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(4);
  });

  it("ends unsuccessful fast polling after two minutes", async () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    vi.mocked(getDesktopAuthStatus).mockResolvedValue(disconnectedStatus);
    render(<DesktopLmsManager />);
    await flushPromises();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "LMS 로그인" }),
      );
      await Promise.resolve();
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    const callsAtDeadline = vi.mocked(getDesktopAuthStatus).mock.calls.length;
    expect(
      screen.getByText(/로그인 확인이 늦어지고 있어요/),
    ).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(59_999);
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(callsAtDeadline);
    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledTimes(
      callsAtDeadline + 1,
    );
  });

  it("shares one in-flight status request across overlapping visibility triggers", async () => {
    vi.useFakeTimers();
    setDocumentHidden(false);
    let resolveStatus:
      | ((status: DesktopAuthStatus) => void)
      | undefined;
    vi.mocked(getDesktopAuthStatus).mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );
    render(<DesktopLmsManager />);
    await flushPromises();
    expect(getDesktopAuthStatus).toHaveBeenCalledOnce();

    setDocumentHidden(true);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      setDocumentHidden(false);
      document.dispatchEvent(new Event("visibilitychange"));
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(getDesktopAuthStatus).toHaveBeenCalledOnce();

    await act(async () => {
      resolveStatus?.(disconnectedStatus);
      await Promise.resolve();
    });
  });
});

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: hidden,
  });
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}
