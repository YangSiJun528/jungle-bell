import {
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";

import {
  claimPairing,
  claimPairingByManualCode,
  completePairing,
  type PairingClaim,
} from "../api-client";
import {
  clearPairingFragment,
  parsePairingFragment,
} from "../pairing-link";
import {
  clearPendingPairingSession,
  PAIRING_SESSION_TTL_MS,
  readPendingPairingSession,
  storePendingPairingSession,
  type PendingPairingSession,
} from "../pairing-session";
import { clearBrowserPushState } from "../push-local-state";
import {
  getMobileInstallationConfirmationCode,
  getOrCreateMobileInstallationId,
} from "../mobile-installation";
import { browserWebPushEnvironment } from "../web-push";

type PairingViewState =
  | "manual"
  | "ready"
  | "claiming"
  | "waiting"
  | "completed"
  | "expired"
  | "error";

interface MobilePairingProps {
  readonly fragment: string;
  readonly manualMode?: boolean;
  readonly onCompleted?: () => void;
}

const TERMINAL_COMPLETION_ERRORS = new Set([
  "PAIRING_EXPIRED",
  "PAIRING_NOT_FOUND",
  "PAIRING_RECEIPT_INVALID",
  "PAIRING_ALREADY_USED",
]);

export function MobilePairing({
  fragment,
  manualMode = false,
  onCompleted = navigateToCompanion,
}: MobilePairingProps) {
  const fragmentPairing = useMemo(
    () => parsePairingFragment(fragment),
    [fragment],
  );
  const initial = useMemo(
    () => initialPairing(fragmentPairing),
    [fragmentPairing],
  );
  const [pairing, setPairing] =
    useState<PendingPairingSession | null>(initial.pairing);
  const [state, setState] = useState<PairingViewState>(initial.state);
  const [manualCode, setManualCode] = useState("");
  const [message, setMessage] = useState("");
  const [confirmationCode, setConfirmationCode] = useState<string | null>(
    () => {
      try {
        return getMobileInstallationConfirmationCode();
      } catch {
        return null;
      }
    },
  );
  const installRequired = requiresInstalledPwaForPairing({
    isStandalone: browserWebPushEnvironment().isStandalone,
    maxTouchPoints: navigator.maxTouchPoints,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  });

  useEffect(() => {
    if (fragmentPairing === null) {
      return;
    }
    const pending: PendingPairingSession = {
      pairingId: fragmentPairing.pairingId,
      challenge: fragmentPairing.challenge,
      claim: null,
      expiresAtEpochMs: Date.now() + PAIRING_SESSION_TTL_MS,
    };
    setPairing(pending);
    setState("ready");
    storePendingPairingSession(pending);
    clearPairingFragment();
  }, [fragmentPairing]);

  useEffect(() => {
    if (
      pairing === null ||
      (state !== "ready" && state !== "waiting")
    ) {
      return;
    }
    const remaining = pairing.expiresAtEpochMs - Date.now();
    if (remaining <= 0) {
      clearPendingPairingSession();
      setPairing(null);
      setState("expired");
      return;
    }
    const timeout = window.setTimeout(() => {
      clearPendingPairingSession();
      setPairing(null);
      setState("expired");
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [pairing, state]);

  useEffect(() => {
    if (state !== "completed") {
      return;
    }
    const timeout = window.setTimeout(onCompleted, 600);
    return () => window.clearTimeout(timeout);
  }, [onCompleted, state]);

  useEffect(() => {
    if (
      installRequired ||
      pairing === null ||
      pairing.claim === null ||
      state !== "waiting"
    ) {
      return;
    }
    const pending = pairing;
    let stopped = false;
    let timer: number | null = null;
    let failures = 0;

    const schedule = (delayMs: number) => {
      const remaining = pending.expiresAtEpochMs - Date.now();
      if (stopped) {
        return;
      }
      if (remaining <= 0) {
        clearPendingPairingSession();
        setPairing(null);
        setState("expired");
        return;
      }
      timer = window.setTimeout(poll, Math.min(delayMs, remaining));
    };

    const poll = () => {
      if (stopped || pending.claim === null) {
        return;
      }
      void completePairing(pending.pairingId, pending.claim)
        .then(async (result) => {
          if (stopped) {
            return;
          }
          failures = 0;
          if (result === "waiting") {
            setMessage("PC에서 이 휴대폰을 승인하면 자동으로 연결돼요.");
            schedule(1_000);
            return;
          }
          clearPendingPairingSession();
          const pushCleared = await clearBrowserPushState();
          if (stopped) {
            return;
          }
          setPairing(null);
          setState("completed");
          setMessage(
            pushCleared
              ? "이전 계정의 브라우저 알림 연결도 정리했어요."
              : "연결됐어요. 알림은 설정에서 다시 연결해 주세요.",
          );
        })
        .catch((error: unknown) => {
          if (stopped) {
            return;
          }
          const code = error instanceof Error ? error.message : "";
          if (TERMINAL_COMPLETION_ERRORS.has(code)) {
            clearPendingPairingSession();
            setPairing(null);
            setState(code === "PAIRING_EXPIRED" ? "expired" : "error");
            setMessage("");
            return;
          }
          failures += 1;
          setMessage(
            "연결이 늦어지고 있어요. 승인 상태를 자동으로 다시 확인할게요.",
          );
          schedule(Math.min(10_000, 500 * 2 ** failures));
        });
    };

    poll();
    return () => {
      stopped = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [installRequired, pairing, state]);

  const requestQrPairing = async () => {
    if (pairing?.challenge === null || pairing === null) {
      return;
    }
    setState("claiming");
    setMessage("");
    try {
      const installationId = getOrCreateMobileInstallationId();
      setConfirmationCode(installationId.slice(-4).toUpperCase());
      const claim = await claimPairing({
        pairingId: pairing.pairingId,
        challenge: pairing.challenge,
        deviceLabel: mobileDeviceLabel(),
        installationId,
      });
      beginWaiting(pairing, claim, setPairing, setState);
    } catch (error) {
      handleClaimFailure(error, setState, setMessage);
    }
  };

  const requestManualPairing = async (event: FormEvent) => {
    event.preventDefault();
    setState("claiming");
    setMessage("");
    try {
      const installationId = getOrCreateMobileInstallationId();
      setConfirmationCode(installationId.slice(-4).toUpperCase());
      const claim = await claimPairingByManualCode({
        manualCode,
        deviceLabel: mobileDeviceLabel(),
        installationId,
      });
      const pending: PendingPairingSession = {
        pairingId: claim.claimId,
        challenge: null,
        claim,
        expiresAtEpochMs: Date.now() + PAIRING_SESSION_TTL_MS,
      };
      storePendingPairingSession(pending);
      setPairing(pending);
      setState("waiting");
    } catch (error) {
      handleClaimFailure(error, setState, setMessage);
    }
  };

  const retryManual = () => {
    clearPendingPairingSession();
    setPairing(null);
    setManualCode("");
    setMessage("");
    setState("manual");
  };

  const content = (
    <>
      <div className="eyebrow">기기 연결</div>
      {manualMode ? <h2>휴대폰 연결</h2> : <h1>휴대폰 연결</h1>}
      {installRequired ? (
        <div className="error-notice" role="status">
          <p>
            iPhone·iPad에서는 Safari와 홈 화면 앱의 로그인 공간이
            달라요. 연결은 홈 화면의 Jungle Bell에서 진행해 주세요.
          </p>
          <ol>
            <li>Safari 공유 메뉴에서 ‘홈 화면에 추가’를 선택해요.</li>
            <li>홈 화면의 Jungle Bell 아이콘으로 앱을 열어요.</li>
            <li>PC 앱에 표시된 10자리 연결 코드를 입력해요.</li>
          </ol>
        </div>
      ) : state === "ready" ? (
        <>
          <p className="muted">
            연결을 요청한 뒤 PC에 표시되는 기기 정보와 확인 코드를
            확인해 주세요.
          </p>
          <button
            className="primary-button"
            type="button"
            onClick={requestQrPairing}
          >
            이 휴대폰 연결 요청
          </button>
        </>
      ) : null}
      {!installRequired &&
      (state === "manual" || state === "error" || state === "expired") ? (
        <ManualPairingForm
          code={manualCode}
          disabled={false}
          message={manualPairingMessage(state, message)}
          onChange={setManualCode}
          onSubmit={requestManualPairing}
        />
      ) : null}
      {!installRequired && state === "claiming" ? (
        <p>연결을 요청하고 있어요.</p>
      ) : null}
      {!installRequired && state === "waiting" ? (
        <>
          <p>PC의 Jungle Bell에서 이 휴대폰을 승인해 주세요.</p>
          {confirmationCode ? (
            <p className="pairing-confirmation">
              양쪽 확인 코드 · <strong>{confirmationCode}</strong>
            </p>
          ) : null}
          <p className="notice" role="status">
            {message || "PC의 승인을 기다리고 있어요."}
          </p>
        </>
      ) : null}
      {!installRequired && state === "completed" ? (
        <>
          <p>연결됐어요. Jungle Bell로 이동할게요.</p>
          <p className="notice" role="status">{message}</p>
        </>
      ) : null}
      {!installRequired &&
      (state === "error" || state === "expired") &&
      pairing !== null ? (
        <button className="secondary-button" type="button" onClick={retryManual}>
          새 코드 입력
        </button>
      ) : null}
    </>
  );

  if (manualMode) {
    return (
      <section className="card mobile-pairing-card companion-onboarding">
        {content}
      </section>
    );
  }
  return (
    <main className="pairing-page">
      <section className="card mobile-pairing-card">{content}</section>
    </main>
  );
}

function ManualPairingForm({
  code,
  disabled,
  message,
  onChange,
  onSubmit,
}: {
  readonly code: string;
  readonly disabled: boolean;
  readonly message: string;
  readonly onChange: (value: string) => void;
  readonly onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="manual-pairing-form" onSubmit={onSubmit}>
      <p className="muted">
        PC 앱에 표시된 10자리 연결 코드를 입력해 주세요. 코드는
        2분 동안 한 번만 사용할 수 있어요.
      </p>
      {message ? (
        <p className="error-notice" role="alert">{message}</p>
      ) : null}
      <label htmlFor="manual-pairing-code">PC 연결 코드</label>
      <input
        id="manual-pairing-code"
        autoCapitalize="characters"
        autoComplete="one-time-code"
        disabled={disabled}
        inputMode="text"
        maxLength={11}
        pattern="[0-9A-Za-z -]{10,11}"
        placeholder="ABCDE-12345"
        required
        spellCheck={false}
        value={code}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button
        className="primary-button"
        disabled={disabled}
        type="submit"
      >
        이 휴대폰 연결 요청
      </button>
    </form>
  );
}

function initialPairing(
  fragment: ReturnType<typeof parsePairingFragment>,
): {
  pairing: PendingPairingSession | null;
  state: PairingViewState;
} {
  if (fragment !== null) {
    return {
      pairing: {
        pairingId: fragment.pairingId,
        challenge: fragment.challenge,
        claim: null,
        expiresAtEpochMs: Date.now() + PAIRING_SESSION_TTL_MS,
      },
      state: "ready",
    };
  }
  const stored = readPendingPairingSession();
  if (stored !== null) {
    return {
      pairing: stored,
      state: stored.claim === null ? "ready" : "waiting",
    };
  }
  return { pairing: null, state: "manual" };
}

function beginWaiting(
  pairing: PendingPairingSession,
  claim: PairingClaim,
  setPairing: (pairing: PendingPairingSession) => void,
  setState: (state: PairingViewState) => void,
) {
  const pending = { ...pairing, claim };
  storePendingPairingSession(pending);
  setPairing(pending);
  setState("waiting");
}

function handleClaimFailure(
  error: unknown,
  setState: (state: PairingViewState) => void,
  setMessage: (message: string) => void,
) {
  const code = error instanceof Error ? error.message : "";
  setState(code === "PAIRING_EXPIRED" ? "expired" : "error");
  setMessage(
    code === "PAIRING_MANUAL_CODE_LOCKED"
      ? "입력 횟수를 초과했어요. 2분 후 PC에서 새 코드를 만들어 주세요."
      : code === "PAIRING_EXPIRED" || code === "PAIRING_NOT_FOUND"
        ? "코드가 잘못됐거나 만료됐어요. PC에서 새 코드를 확인해 주세요."
        : code === "API_CLIENT_INVALID_ARGUMENT"
          ? "10자리 연결 코드를 확인해 주세요."
          : "연결을 요청하지 못했어요. 네트워크를 확인하고 다시 시도해 주세요.",
  );
}

function manualPairingMessage(
  state: PairingViewState,
  message: string,
): string {
  if (message) {
    return message;
  }
  return state === "expired"
    ? "연결 요청이 만료됐어요. PC에서 새 코드를 만들어 주세요."
    : "";
}

function mobileDeviceLabel(): string {
  const platform = navigator.platform;
  return platform
    ? `Jungle Bell · ${platform}`.slice(0, 80)
    : "Jungle Bell 모바일";
}

function navigateToCompanion(): void {
  window.location.replace("/app");
}

export function requiresInstalledPwaForPairing(input: {
  readonly isStandalone: boolean;
  readonly maxTouchPoints: number;
  readonly platform: string;
  readonly userAgent: string;
}): boolean {
  const appleMobile =
    /iPad|iPhone|iPod/iu.test(input.userAgent) ||
    (input.platform === "MacIntel" && input.maxTouchPoints > 1);
  return appleMobile && !input.isStandalone;
}
