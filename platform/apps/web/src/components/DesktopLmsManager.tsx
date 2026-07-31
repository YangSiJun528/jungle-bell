import { useEffect, useRef, useState } from "react";

import {
  disconnectLms,
  getDesktopAuthStatus,
  type DesktopAuthState,
  type DesktopAuthStatus,
} from "../api-client";
import {
  clearLocalDesktopSession,
  startLmsLogin,
} from "../desktop-bridge";
import { ConfirmDialog } from "./ui";

type DisplayState = DesktopAuthState | "loading" | "error";
const NORMAL_POLL_INTERVAL_MS = 60_000;
const LOGIN_POLL_INTERVAL_MS = 2_000;
const LOGIN_POLL_WINDOW_MS = 2 * 60_000;

const EMPTY_STATUS: DesktopAuthStatus = {
  state: "disconnected",
  desktopId: null,
  lastVerifiedAt: null,
  lastSeenAt: null,
  health: null,
};

export function DesktopLmsManager({
  onStatusChange,
}: {
  onStatusChange?: (status: DesktopAuthStatus) => void;
}) {
  const [status, setStatus] = useState<DesktopAuthStatus>(EMPTY_STATUS);
  const [displayState, setDisplayState] = useState<DisplayState>("loading");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const onStatusChangeRef = useRef(onStatusChange);
  const mountedRef = useRef(false);
  const statusRef = useRef<DesktopAuthStatus>(EMPTY_STATUS);
  const requestRef = useRef<Promise<DesktopAuthStatus | null> | null>(
    null,
  );
  const requestGenerationRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const loginDeadlineRef = useRef<number | null>(null);
  const loginBaselineRef = useRef<{
    readonly state: DesktopAuthState;
    readonly lastVerifiedAt: string | null;
  } | null>(null);
  onStatusChangeRef.current = onStatusChange;

  const clearScheduledPoll = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const stopLoginPolling = () => {
    loginDeadlineRef.current = null;
    loginBaselineRef.current = null;
  };

  const refreshStatus = (): Promise<DesktopAuthStatus | null> => {
    if (requestRef.current !== null) {
      return requestRef.current;
    }
    const requestGeneration = requestGenerationRef.current;
    const request = getDesktopAuthStatus()
      .then((next) => {
        if (
          !mountedRef.current ||
          requestGeneration !== requestGenerationRef.current
        ) {
          return null;
        }
        statusRef.current = next;
        setStatus(next);
        setDisplayState(next.state);
        if (loginDeadlineRef.current === null) {
          setMessage("");
        }
        onStatusChangeRef.current?.(next);
        return next;
      })
      .catch(() => {
        if (
          !mountedRef.current ||
          requestGeneration !== requestGenerationRef.current
        ) {
          return null;
        }
        setDisplayState("error");
        setMessage(
          "LMS 연결 상태를 확인하지 못했어요. 기존 로그인은 그대로 유지해요.",
        );
        return null;
      })
      .finally(() => {
        requestRef.current = null;
      });
    requestRef.current = request;
    return request;
  };

  const schedulePoll = (delayMs: number) => {
    clearScheduledPoll();
    if (!mountedRef.current || document.hidden) {
      return;
    }
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void runPoll(false);
    }, delayMs);
  };

  const loginCompleted = (next: DesktopAuthStatus): boolean => {
    const baseline = loginBaselineRef.current;
    if (baseline === null || next.state !== "connected") {
      return false;
    }
    return (
      baseline.state !== "connected" ||
      next.lastVerifiedAt !== baseline.lastVerifiedAt
    );
  };

  const runPoll = async (forceAtDeadline: boolean) => {
    clearScheduledPoll();
    if (!mountedRef.current || document.hidden) {
      return;
    }
    const loginDeadline = loginDeadlineRef.current;
    if (
      !forceAtDeadline &&
      loginDeadline !== null &&
      Date.now() >= loginDeadline
    ) {
      stopLoginPolling();
      setMessage(
        "로그인 확인이 늦어지고 있어요. 로그인을 마쳤다면 상태를 다시 확인해 주세요.",
      );
      schedulePoll(NORMAL_POLL_INTERVAL_MS);
      return;
    }

    const next = await refreshStatus();
    if (!mountedRef.current || document.hidden) {
      return;
    }
    const currentDeadline = loginDeadlineRef.current;
    if (currentDeadline !== null) {
      if (next !== null && loginCompleted(next)) {
        stopLoginPolling();
        setMessage("LMS 연결을 확인했어요.");
        schedulePoll(NORMAL_POLL_INTERVAL_MS);
        return;
      }
      const remainingMs = currentDeadline - Date.now();
      if (remainingMs > 0) {
        schedulePoll(Math.min(LOGIN_POLL_INTERVAL_MS, remainingMs));
        return;
      }
      stopLoginPolling();
      setMessage(
        "로그인 확인이 늦어지고 있어요. 로그인을 마쳤다면 상태를 다시 확인해 주세요.",
      );
    }
    schedulePoll(NORMAL_POLL_INTERVAL_MS);
  };

  useEffect(() => {
    mountedRef.current = true;
    let wasHidden = document.hidden;
    const handleVisibilityChange = () => {
      const hidden = document.hidden;
      clearScheduledPoll();
      if (hidden) {
        wasHidden = true;
      } else if (wasHidden) {
        wasHidden = false;
        void runPoll(true);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    if (!document.hidden) {
      void runPoll(true);
    }
    return () => {
      mountedRef.current = false;
      clearScheduledPoll();
      document.removeEventListener(
        "visibilitychange",
        handleVisibilityChange,
      );
    };
  }, []);

  const login = async () => {
    setBusy(true);
    setMessage("");
    const baseline = statusRef.current;
    try {
      await startLmsLogin();
      if (baseline.state === "connected") {
        stopLoginPolling();
        setMessage("LMS 출석 페이지를 열었어요.");
        schedulePoll(NORMAL_POLL_INTERVAL_MS);
        return;
      }
      loginBaselineRef.current = {
        state: baseline.state,
        lastVerifiedAt: baseline.lastVerifiedAt,
      };
      loginDeadlineRef.current = Date.now() + LOGIN_POLL_WINDOW_MS;
      setMessage("열린 로그인 창에서 LMS 로그인을 완료해 주세요.");
      void runPoll(true);
    } catch {
      setMessage("LMS 로그인 창을 열지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage("");
    stopLoginPolling();
    clearScheduledPoll();
    requestGenerationRef.current += 1;
    let serverDisconnected = false;
    let localCleared = false;
    try {
      await disconnectLms();
      serverDisconnected = true;
    } catch {
      // Local cleanup still has to run after an earlier server-side revoke or
      // while the server is temporarily unreachable.
    }
    try {
      await clearLocalDesktopSession();
      localCleared = true;
    } catch {
      // The result below reports the partial failure without hiding it.
    }
    if (serverDisconnected || localCleared) {
      statusRef.current = EMPTY_STATUS;
      setStatus(EMPTY_STATUS);
      setDisplayState("disconnected");
      onStatusChangeRef.current?.(EMPTY_STATUS);
      setMessage(
        serverDisconnected && localCleared
          ? "이 PC의 LMS 연결을 해제했어요."
          : serverDisconnected
            ? "서버 연결은 해제했지만 이 PC의 LMS 정보를 지우지 못했어요. 앱을 다시 시작한 뒤 다시 시도해 주세요."
            : "이 PC의 LMS 정보는 지웠지만 서버 연결 해제 여부를 확인하지 못했어요.",
      );
    } else {
      setMessage("LMS 연결을 해제하지 못했어요.");
    }
    setBusy(false);
    setDisconnectOpen(false);
    schedulePoll(NORMAL_POLL_INTERVAL_MS);
  };

  const connected =
    status.state !== "disconnected" && displayState !== "loading";
  const retryStatus = () => {
    setMessage("");
    void runPoll(true);
  };

  return (
    <article className="card auth-card">
      <div className="eyebrow">LMS 연결</div>
      <h2>로그인 상태</h2>
      <div className="lms-state" aria-live="polite">
        <span className={`dot lms-dot ${displayState}`} />
        {statusLabel(displayState)}
      </div>
      <p className="muted">{statusDescription(displayState)}</p>
      {status.lastVerifiedAt ? (
        <p className="metadata">
          LMS 계정 확인 · {formatDate(status.lastVerifiedAt)}
        </p>
      ) : null}
      <div className="button-row">
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={displayState === "error" ? retryStatus : login}
        >
          {displayState === "error"
            ? "상태 다시 확인"
            : displayState === "connected"
              ? "출석 페이지 열기"
              : "LMS 로그인"}
        </button>
        {connected ? (
          <button
            className="ui-button ui-button--danger"
            type="button"
            disabled={busy}
            onClick={() => setDisconnectOpen(true)}
          >
            LMS 연결 해제
          </button>
        ) : null}
      </div>
      {message ? <p className="notice" role="status">{message}</p> : null}
      <ConfirmDialog
        busy={busy}
        confirmLabel="연결 해제"
        danger
        description={
          <>
            이 PC에서 출석 확인이 중지되고 이 PC에 저장된 LMS 로그인 정보가
            삭제돼요. 다시 사용하려면 LMS에 로그인해야 해요.
          </>
        }
        open={disconnectOpen}
        title="LMS 연결을 해제할까요?"
        onClose={() => setDisconnectOpen(false)}
        onConfirm={() => void disconnect()}
      />
    </article>
  );
}

function statusLabel(state: DisplayState): string {
  switch (state) {
    case "loading":
      return "LMS 상태 확인 중";
    case "error":
      return "LMS 상태 확인 지연";
    case "connected":
      return "LMS 연결됨";
    case "unknown":
      return "LMS 연결 확인 필요";
    case "expiring":
      return "LMS 연결 만료 임박";
    case "expired":
      return "LMS 로그인 만료";
    case "disconnected":
      return "LMS 연결 안 됨";
  }
}

function statusDescription(state: DisplayState): string {
  switch (state) {
    case "connected":
      return "로그인 정보는 이 PC에만 저장하고, 확인한 출석 결과만 동기화해요.";
    case "unknown":
      return "이 PC의 최근 상태를 아직 확인하지 못했어요. 필요하면 다시 로그인해 주세요.";
    case "expiring":
      return "이 PC에서 LMS 로그인을 다시 확인해 주세요.";
    case "expired":
      return "출석 확인을 계속하려면 이 PC에서 다시 로그인해야 해요.";
    case "loading":
      return "이 PC의 LMS 로그인 상태를 확인하고 있어요.";
    case "error":
      return "연결이 복구되면 기존 로그인 상태를 다시 확인해요.";
    case "disconnected":
      return "LMS에 로그인하면 출석 확인과 휴대폰 연결을 사용할 수 있어요.";
  }
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf())
    ? value
    : parsed.toLocaleString("ko-KR", {
        dateStyle: "medium",
        timeStyle: "short",
      });
}
