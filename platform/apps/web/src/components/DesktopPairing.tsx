import { useEffect, useState } from "react";
import QRCode from "react-qr-code";

import {
  approveMobilePairing,
  createMobilePairing,
  getMobilePairingStatus,
  type MobilePairingCreated,
  type MobilePairingStatus,
} from "../api-client";
import { shouldPollPairing } from "../pairing-poll";

export function DesktopPairing({ enabled }: { enabled: boolean }) {
  const [pairing, setPairing] = useState<MobilePairingCreated | null>(null);
  const [status, setStatus] = useState<MobilePairingStatus | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [expired, setExpired] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  useEffect(() => {
    if (pairing === null || expired) {
      setRemainingSeconds(0);
      return;
    }
    const update = () => {
      setRemainingSeconds(
        Math.max(
          0,
          Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1_000),
        ),
      );
    };
    update();
    const interval = window.setInterval(update, 1_000);
    return () => window.clearInterval(interval);
  }, [expired, pairing]);

  useEffect(() => {
    if (
      pairing === null ||
      expired ||
      (status !== null && !shouldPollPairing(status.status))
    ) {
      return;
    }
    const deadline = Date.parse(pairing.expiresAt);
    let stopped = false;
    let timerId: number | null = null;
    let failures = 0;
    const schedule = (delayMs: number) => {
      const remaining = deadline - Date.now();
      if (stopped || remaining <= 0) {
        setExpired(true);
        setMessage("연결 코드가 만료됐어요. 새 코드를 만들어 주세요.");
        return;
      }
      timerId = window.setTimeout(poll, Math.min(delayMs, remaining));
    };
    const poll = () => {
      if (Date.now() >= deadline) {
        setExpired(true);
        setMessage("연결 코드가 만료됐어요. 새 코드를 만들어 주세요.");
        return;
      }
      void getMobilePairingStatus(pairing.pairingId)
        .then((next) => {
          if (stopped) return;
          failures = 0;
          setStatus(next);
          setMessage("");
          if (shouldPollPairing(next.status)) {
            schedule(1_000);
          }
        })
        .catch((error: unknown) => {
          if (stopped) return;
          const code =
            error instanceof Error ? error.message : "";
          if (
            code === "PAIRING_EXPIRED" ||
            code === "PAIRING_NOT_FOUND"
          ) {
            setExpired(true);
            setMessage("연결 코드가 만료됐어요. 새 코드를 만들어 주세요.");
            return;
          }
          failures += 1;
          setMessage(
            "연결 상태 확인이 늦어지고 있어요. 자동으로 다시 확인할게요.",
          );
          schedule(Math.min(10_000, 1_000 * 2 ** failures));
        });
    };
    schedule(1_000);
    return () => {
      stopped = true;
      if (timerId !== null) {
        window.clearTimeout(timerId);
      }
    };
  }, [expired, pairing, status?.status]);

  const start = async () => {
    if (!enabled) {
      setMessage("먼저 이 PC에서 LMS에 로그인해 주세요.");
      return;
    }
    setBusy(true);
    setMessage("");
    setExpired(false);
    try {
      const created = await createMobilePairing();
      setPairing(created);
      setStatus({ status: "pending", claim: null });
    } catch {
      setMessage("휴대폰 연결 코드를 만들지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (
      pairing === null ||
      status?.claim === null ||
      status?.claim === undefined
    ) {
      return;
    }
    setBusy(true);
    try {
      await approveMobilePairing(
        pairing.pairingId,
        status.claim.claimId,
      );
      setStatus({ status: "approved", claim: null });
      setMessage("휴대폰 연결을 승인했어요.");
    } catch {
      setMessage("휴대폰 연결을 승인하지 못했어요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="card pairing-card">
      <div>
        <div className="eyebrow">
          일회용 ·{" "}
          {pairing !== null && !expired
            ? `${remainingSeconds}초 남음`
            : "2분 유효"}
        </div>
        <h2>휴대폰 연결</h2>
        {pairing === null ? (
          <>
            <p className="muted">
              {enabled
                ? "연결 코드에는 LMS 로그인 정보가 들어가지 않으며 2분 뒤 만료돼요."
                : "LMS 로그인 후 휴대폰 앱을 이 PC와 연결할 수 있어요."}
            </p>
            <button
              className="primary-button"
              type="button"
              disabled={busy || !enabled}
              onClick={start}
            >
              연결 코드 만들기
            </button>
          </>
        ) : expired ? (
          <>
            <p className="muted">
              이 연결 코드는 더 이상 사용할 수 없어요.
            </p>
            <button
              className="primary-button"
              type="button"
              disabled={busy || !enabled}
              onClick={start}
            >
              새 연결 코드 만들기
            </button>
          </>
        ) : status?.status === "claimed" && status.claim ? (
          <>
            <p className="muted" role="status" aria-live="polite">
              <strong>{status.claim.deviceLabel}</strong>에서 연결을
              요청했어요. 휴대폰에 표시된 확인 코드{" "}
              <strong>{status.claim.confirmationCode}</strong>가 같은지 확인해
              주세요.
            </p>
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={approve}
            >
              이 기기 승인
            </button>
          </>
        ) : (
          <p className="muted">
            {status?.status === "approved" || status?.status === "completed"
              ? "승인 완료"
              : "휴대폰의 Jungle Bell에서 10자리 연결 코드를 입력해 주세요. QR로도 연결할 수 있어요."}
          </p>
        )}
        {message ? (
          <p
            className="notice"
            role={
              /못했|만료|필요|늦/u.test(message)
                ? "alert"
                : "status"
            }
            aria-live="polite"
          >
            {message}
          </p>
        ) : null}
      </div>
      {pairing &&
      !expired &&
      status?.status !== "approved" &&
      status?.status !== "completed" ? (
        <div className="pairing-proof">
          <div className="qr-frame" aria-label="휴대폰 연결 QR">
            <QRCode size={132} value={pairing.qrPayload} />
            <span className="qr-caption">휴대폰으로 스캔</span>
          </div>
          <div className="manual-pairing-proof">
            <span>Jungle Bell에서 입력</span>
            <code aria-label="휴대폰 연결 코드">
              {pairing.manualCode.slice(0, 5)}-
              {pairing.manualCode.slice(5)}
            </code>
          </div>
        </div>
      ) : null}
    </article>
  );
}
