import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  disconnectMobileDeviceSession,
  getMobileDeviceSessions,
  revokeMobileDeviceSession,
} from "../api-client";
import { clearBrowserPushState } from "../push-local-state";
import { MobileSessionManager } from "./MobileSessionManager";

vi.mock("../api-client", () => ({
  disconnectMobileDeviceSession: vi.fn(),
  getMobileDeviceSessions: vi.fn(),
  revokeMobileDeviceSession: vi.fn(),
}));

vi.mock("../push-local-state", () => ({
  clearBrowserPushState: vi.fn(),
}));

const session = {
  sessionId: `jbsi_${"1".repeat(32)}`,
  deviceId: `jbd_${"2".repeat(32)}`,
  deviceLabel: "모바일 PWA · iPhone",
  scopes: [
    "attendance:read",
    "notifications:receive",
    "preferences:read",
    "preferences:write",
  ] as const,
  createdAt: "2026-07-01T00:00:00.000Z",
  expiresAt: "2026-07-31T00:00:00.000Z",
  revokedAt: null,
  status: "active" as const,
};

describe("MobileSessionManager", () => {
  beforeEach(() => {
    vi.mocked(getMobileDeviceSessions).mockReset();
    vi.mocked(revokeMobileDeviceSession).mockReset();
    vi.mocked(disconnectMobileDeviceSession).mockReset();
    vi.mocked(clearBrowserPushState).mockReset();
    vi.mocked(getMobileDeviceSessions).mockResolvedValue({
      sessions: [session],
    });
    vi.mocked(revokeMobileDeviceSession).mockResolvedValue();
    vi.mocked(disconnectMobileDeviceSession).mockResolvedValue();
    vi.mocked(clearBrowserPushState).mockResolvedValue(true);
  });

  it("lists and revokes this user's mobile sessions on desktop", async () => {
    render(<MobileSessionManager mode="desktop" />);

    expect(await screen.findByText(session.deviceLabel)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "연결 해제" }));
    await waitFor(() =>
      expect(revokeMobileDeviceSession).toHaveBeenCalledWith(
        session.sessionId,
      ),
    );
    expect(screen.getByText(/연결 해제됨/)).toBeVisible();
  });

  it("revokes the self session and browser Push on companion logout", async () => {
    const onSignedOut = vi.fn();
    render(
      <MobileSessionManager
        mode="companion"
        onSignedOut={onSignedOut}
      />,
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "이 휴대폰 연결 해제" }),
      );
    });

    expect(disconnectMobileDeviceSession).toHaveBeenCalledOnce();
    expect(clearBrowserPushState).toHaveBeenCalledOnce();
    expect(onSignedOut).toHaveBeenCalledOnce();
  });
});
