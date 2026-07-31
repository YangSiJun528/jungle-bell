import { useCallback, useEffect, useState } from "react";

import {
  disconnectMobileDeviceSession,
  getMobileDeviceSessions,
  revokeMobileDeviceSession,
  type MobileDeviceSessionDto,
} from "../api-client";
import { clearBrowserPushState } from "../push-local-state";

type SessionView =
  | { readonly state: "loading" }
  | { readonly state: "error" }
  | {
      readonly state: "loaded";
      readonly sessions: readonly MobileDeviceSessionDto[];
    };

export function MobileSessionManager({
  mode,
  onSignedOut = reloadCompanion,
}: {
  readonly mode: "desktop" | "companion";
  readonly onSignedOut?: () => void;
}) {
  const [view, setView] = useState<SessionView>({ state: "loading" });
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async (showLoading: boolean) => {
    if (mode !== "desktop") {
      return;
    }
    if (showLoading) {
      setView({ state: "loading" });
    }
    try {
      setView({
        state: "loaded",
        sessions: (await getMobileDeviceSessions()).sessions,
      });
    } catch {
      if (showLoading) {
        setView({ state: "error" });
      } else {
        setMessage("연결된 휴대폰 목록을 새로 확인하지 못했어요.");
      }
    }
  }, [mode]);

  useEffect(() => {
    if (mode !== "desktop") {
      return;
    }
    void load(true);
    const interval = window.setInterval(() => void load(false), 60_000);
    return () => window.clearInterval(interval);
  }, [load, mode]);

  const revoke = async (sessionId: string) => {
    setBusySessionId(sessionId);
    setMessage("");
    try {
      await revokeMobileDeviceSession(sessionId);
      setView((current) =>
        current.state !== "loaded"
          ? current
          : {
              state: "loaded",
              sessions: current.sessions.map((session) =>
                session.sessionId === sessionId
                  ? {
                      ...session,
                      status: "revoked",
                      revokedAt: new Date().toISOString(),
                    }
                  : session,
              ),
            },
      );
      setMessage("휴대폰 연결을 해제했어요.");
    } catch {
      setMessage("휴대폰 연결을 해제하지 못했어요.");
    } finally {
      setBusySessionId(null);
    }
  };

  const signOut = async () => {
    setBusySessionId("self");
    setMessage("");
    try {
      await disconnectMobileDeviceSession();
      const pushCleared = await clearBrowserPushState();
      setMessage(
        pushCleared
          ? "이 휴대폰의 연결과 브라우저 알림을 해제했어요."
          : "계정 연결은 해제했어요. 브라우저 알림 권한은 설정에서 확인해 주세요.",
      );
      onSignedOut();
    } catch {
      setMessage("이 휴대폰의 계정 연결을 해제하지 못했어요.");
    } finally {
      setBusySessionId(null);
    }
  };

  if (mode === "companion") {
    return (
      <section className="card settings-card">
        <div className="eyebrow">이 휴대폰</div>
        <h2>계정 연결</h2>
        <p className="muted">
          연결을 해제하면 이 휴대폰에서 출석 조회와 개인 알림이
          중지돼요.
        </p>
        <button
          className="secondary-button"
          disabled={busySessionId !== null}
          type="button"
          onClick={signOut}
        >
          이 휴대폰 연결 해제
        </button>
        {message ? <p className="notice" role="status">{message}</p> : null}
      </section>
    );
  }

  return (
    <section className="card settings-card" aria-busy={view.state === "loading"}>
      <div className="section-heading">
        <div>
          <div className="eyebrow">내 기기</div>
          <h2>연결된 휴대폰</h2>
        </div>
        <button
          className="secondary-button"
          disabled={view.state === "loading"}
          type="button"
          onClick={() => void load(true)}
        >
          새로고침
        </button>
      </div>
      {view.state === "loading" ? (
        <p className="muted">연결된 휴대폰을 불러오고 있어요.</p>
      ) : view.state === "error" ? (
        <p className="error-notice" role="alert">
          연결된 휴대폰을 불러오지 못했어요.
        </p>
      ) : view.sessions.length === 0 ? (
        <p className="muted">연결한 휴대폰이 없어요.</p>
      ) : (
        <ul className="compact-list" aria-label="모바일 연결 기기">
          {view.sessions.map((session) => (
            <li key={session.sessionId}>
              <span>
                <strong>{session.deviceLabel}</strong>
                <span className="metadata">
                  {" · "}
                  {sessionStatusLabel(session.status)}
                  {" · 연결 "}
                  <time dateTime={session.createdAt}>
                    {formatDate(session.createdAt)}
                  </time>
                  {session.status === "active" ? (
                    <>
                      {" · 만료 "}
                      <time dateTime={session.expiresAt}>
                        {formatDate(session.expiresAt)}
                      </time>
                    </>
                  ) : null}
                </span>
              </span>
              {session.status === "active" ? (
                <button
                  className="compact-button"
                  disabled={busySessionId !== null}
                  type="button"
                  onClick={() => void revoke(session.sessionId)}
                >
                  연결 해제
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {message ? <p className="notice" role="status">{message}</p> : null}
    </section>
  );
}

function sessionStatusLabel(
  status: MobileDeviceSessionDto["status"],
): string {
  switch (status) {
    case "active":
      return "사용 중";
    case "revoked":
      return "연결 해제됨";
    case "expired":
      return "만료됨";
  }
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}

function reloadCompanion(): void {
  window.location.replace("/app");
}
