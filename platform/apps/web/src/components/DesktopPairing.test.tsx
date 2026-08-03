import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  approveMobilePairing,
  createMobilePairing,
  getMobilePairingStatus,
} from "../api-client";
import { DesktopPairing } from "./DesktopPairing";

vi.mock("../api-client", () => ({
  approveMobilePairing: vi.fn(),
  createMobilePairing: vi.fn(),
  getMobilePairingStatus: vi.fn(),
}));

const pairingId = "jbc_0123456789abcdef0123456789abcdef";

describe("DesktopPairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T09:00:00.000Z"));
    vi.mocked(approveMobilePairing).mockReset();
    vi.mocked(createMobilePairing).mockReset();
    vi.mocked(getMobilePairingStatus).mockReset();
    vi.mocked(createMobilePairing).mockResolvedValue({
      pairingId,
      qrPayload: `https://bell.example.com/pair#pairing=${pairingId}&challenge=jbp_${"a".repeat(64)}`,
      manualCode: "01ABCDEFGH",
      expiresAt: "2026-07-30T10:00:00.000Z",
    });
    vi.mocked(getMobilePairingStatus).mockResolvedValue({
      status: "claimed",
      claim: {
        claimId: pairingId,
        deviceLabel: "iPhone",
        confirmationCode: "1A2F",
      },
    });
    vi.mocked(approveMobilePairing).mockResolvedValue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates, polls, and approves pairing through the cookie-auth API", async () => {
    render(<DesktopPairing enabled />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "연결 코드 만들기" }),
      );
      await Promise.resolve();
    });
    expect(createMobilePairing).toHaveBeenCalledWith();
    expect(screen.getByLabelText("휴대폰 연결 QR")).toBeVisible();
    expect(
      screen.getByLabelText("휴대폰 연결 코드"),
    ).toHaveTextContent("01ABC-DEFGH");

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
    });
    expect(getMobilePairingStatus).toHaveBeenCalledWith(pairingId);
    expect(screen.getByText("iPhone")).toBeVisible();
    expect(screen.getByText("1A2F")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "휴대폰에 표시된 확인 코드",
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "이 기기 승인" }),
      );
      await Promise.resolve();
    });
    expect(approveMobilePairing).toHaveBeenCalledWith(pairingId, pairingId);
    expect(screen.getByText("휴대폰 연결을 승인했어요.")).toBeVisible();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "다른 휴대폰 연결" }),
      );
      await Promise.resolve();
    });
    expect(createMobilePairing).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText("휴대폰 연결 QR")).toBeVisible();
  });

  it("does not offer a pairing proof before LMS login", () => {
    render(<DesktopPairing enabled={false} />);

    expect(
      screen.getByRole("button", { name: "연결 코드 만들기" }),
    ).toBeDisabled();
    expect(createMobilePairing).not.toHaveBeenCalled();
  });

  it("stops polling at the server deadline and offers a fresh QR", async () => {
    render(<DesktopPairing enabled />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "연결 코드 만들기" }),
      );
      await Promise.resolve();
      vi.advanceTimersByTime(60 * 60 * 1_000);
      await Promise.resolve();
    });

    expect(
      screen.getByRole("button", { name: "새 연결 코드 만들기" }),
    ).toBeVisible();
    const callsAtExpiry = vi.mocked(getMobilePairingStatus).mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(10 * 60 * 1_000);
    });
    expect(getMobilePairingStatus).toHaveBeenCalledTimes(callsAtExpiry);
  });
});
