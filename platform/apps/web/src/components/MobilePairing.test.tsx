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
  claimPairing,
  claimPairingByManualCode,
  completePairing,
  type PairingClaim,
} from "../api-client";
import { storePendingPairingSession } from "../pairing-session";
import { clearBrowserPushState } from "../push-local-state";
import {
  MobilePairing,
  requiresInstalledPwaForPairing,
} from "./MobilePairing";

vi.mock("../api-client", () => ({
  claimPairing: vi.fn(),
  claimPairingByManualCode: vi.fn(),
  completePairing: vi.fn(),
}));

vi.mock("../push-local-state", () => ({
  clearBrowserPushState: vi.fn(),
}));

const pairingId = `jbc_${"a".repeat(32)}`;
const challenge = `jbp_${"b".repeat(64)}`;
const claim: PairingClaim = {
  claimId: pairingId,
  claimReceipt: `jbcr_${"c".repeat(64)}`,
  status: "awaiting-desktop-approval",
};

describe("MobilePairing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-31T00:00:00.000Z"));
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/pair");
    vi.mocked(claimPairing).mockReset();
    vi.mocked(claimPairingByManualCode).mockReset();
    vi.mocked(completePairing).mockReset();
    vi.mocked(clearBrowserPushState).mockReset();
    vi.mocked(clearBrowserPushState).mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("claims a QR proof without a fake device public key", async () => {
    vi.mocked(claimPairing).mockResolvedValue(claim);
    vi.mocked(completePairing).mockResolvedValue("waiting");
    render(
      <MobilePairing
        fragment={`#pairing=${pairingId}&challenge=${challenge}`}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "이 휴대폰 연결 요청",
      }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(claimPairing).toHaveBeenCalledWith({
      pairingId,
      challenge,
      deviceLabel: expect.stringContaining("Jungle Bell"),
      installationId: expect.stringMatching(/^jbmi_[0-9a-f]{32}$/u),
    });
    expect(window.location.hash).toBe("");
    expect(
      screen.getByText("PC의 Jungle Bell에서 이 휴대폰을 승인해 주세요."),
    ).toBeVisible();
    expect(screen.getByText(/[0-9A-F]{4}/u)).toBeVisible();
  });

  it("supports installed-PWA manual codes and retries completion failures", async () => {
    const onCompleted = vi.fn();
    vi.mocked(claimPairingByManualCode).mockResolvedValue(claim);
    vi.mocked(completePairing)
      .mockRejectedValueOnce(new Error("HTTP_503"))
      .mockResolvedValueOnce("completed");
    render(
      <MobilePairing
        fragment=""
        manualMode
        onCompleted={onCompleted}
      />,
    );

    fireEvent.change(screen.getByLabelText("PC 연결 코드"), {
      target: { value: "01abc-defgh" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "이 휴대폰 연결 요청",
      }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(claimPairingByManualCode).toHaveBeenCalledWith({
      manualCode: "01abc-defgh",
      deviceLabel: expect.stringContaining("Jungle Bell"),
      installationId: expect.stringMatching(/^jbmi_[0-9a-f]{32}$/u),
    });
    expect(
      screen.getByText(/연결이 늦어지고 있어요/),
    ).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(1_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(completePairing).toHaveBeenCalledTimes(2);
    expect(clearBrowserPushState).toHaveBeenCalledOnce();
    expect(screen.getByText(/연결됐어요/)).toBeVisible();

    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(onCompleted).toHaveBeenCalledOnce();
  });

  it("recovers an approved claim after a PWA reload", async () => {
    const onCompleted = vi.fn();
    storePendingPairingSession({
      pairingId,
      challenge: null,
      claim,
      expiresAtEpochMs: Date.now() + 60_000,
    });
    vi.mocked(completePairing).mockResolvedValue("completed");
    render(
      <MobilePairing fragment="" manualMode onCompleted={onCompleted} />,
    );

    expect(
      screen.getByText("PC의 Jungle Bell에서 이 휴대폰을 승인해 주세요."),
    ).toBeVisible();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(completePairing).toHaveBeenCalledWith(pairingId, claim);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("clears a terminal receipt failure and allows a new manual code", async () => {
    storePendingPairingSession({
      pairingId,
      challenge: null,
      claim,
      expiresAtEpochMs: Date.now() + 60_000,
    });
    vi.mocked(completePairing).mockRejectedValue(
      new Error("PAIRING_RECEIPT_INVALID"),
    );
    render(<MobilePairing fragment="" manualMode />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByLabelText("PC 연결 코드")).toBeVisible();
    expect(window.sessionStorage.length).toBe(0);
  });

  it("requires iOS users to pair inside the installed Home Screen PWA", () => {
    expect(
      requiresInstalledPwaForPairing({
        isStandalone: false,
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      }),
    ).toBe(true);
    expect(
      requiresInstalledPwaForPairing({
        isStandalone: true,
        maxTouchPoints: 5,
        platform: "iPhone",
        userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
      }),
    ).toBe(false);
  });
});
