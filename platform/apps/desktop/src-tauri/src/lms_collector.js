(() => {
  "use strict";

  const LMS_ORIGIN = "https://jungle-lms.krafton.com";
  const AGENT_KEY = "__JUNGLE_BELL_LMS_AGENT__";
  const MAX_JSON_BYTES = 512 * 1024;
  const MAX_COHORTS = 64;
  const LMS_FETCH_TIMEOUT_MS = 12_000;
  const ATTENDANCE_DAY_ROLLOVER_KST_HOUR = 4;
  const ATTENDANCE_CONFIRMATION_DELAYS_MS = [600, 1_500, 3_000, 5_000, 8_000];
  const ATTENDANCE_START_LABEL = "학습 시작";

  if (window.location.origin !== LMS_ORIGIN) return;

  const existing = window[AGENT_KEY];
  if (existing && typeof existing.collect === "function") {
    void existing.collect();
    return;
  }

  let inFlight = false;
  let attendanceConfirmationGeneration = 0;

  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);

  const hasControl = (value) => /[\u0000-\u001f\u007f]/u.test(value);

  const byteLength = (value) => {
    if (typeof TextEncoder === "function") {
      return new TextEncoder().encode(value).byteLength;
    }
    return unescape(encodeURIComponent(value)).length;
  };

  const validIdentifier = (value) =>
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !hasControl(value);

  const isDateString = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
    const parsed = Date.parse(`${value}T00:00:00.000Z`);
    return (
      Number.isFinite(parsed) &&
      new Date(parsed).toISOString().slice(0, 10) === value
    );
  };

  const kstDateString = (epochMs) =>
    new Date(epochMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const attendanceDateString = (epochMs) =>
    new Date(
      epochMs +
        (9 - ATTENDANCE_DAY_ROLLOVER_KST_HOUR) * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);

  const normalizeLmsDate = (value) => {
    if (typeof value !== "string" || value.length > 80) return null;
    if (isDateString(value)) return value;
    const prefix = /^(\d{4}-\d{2}-\d{2})/u.exec(value)?.[1];
    const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value);
    if (prefix && !hasTimezone && isDateString(prefix)) return prefix;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? kstDateString(timestamp) : null;
  };

  const readJson = async (response, allowEmpty = false) => {
    const text = await response.text();
    if (byteLength(text) > MAX_JSON_BYTES) throw new Error("response-too-large");
    if (text.trim() === "") {
      if (allowEmpty) return null;
      throw new Error("empty-response");
    }
    return JSON.parse(text);
  };

  const isLoginResponse = (response) => {
    if (response.status === 401 || response.status === 403) return true;
    try {
      const url = new URL(response.url);
      return (
        url.origin === LMS_ORIGIN &&
        (url.pathname === "/login" || url.pathname.startsWith("/login/"))
      );
    } catch (_) {
      return false;
    }
  };

  const invokeReport = async (report) => {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== "function") return;
    await invoke("report_lms_agent_event", {
      report: JSON.stringify(report),
    });
  };

  const reportLoginRequired = () =>
    invokeReport({ state: "login-required" });

  const reportSessionConnected = (subject) =>
    invokeReport({ state: "session-connected", subject });

  const reportDiagnostic = (stage, reason) =>
    invokeReport({ state: "collector-diagnostic", stage, reason });

  const parseSubject = (value) => {
    if (!isRecord(value)) return null;
    const raw = value.id;
    if (typeof raw !== "string" && typeof raw !== "number") return null;
    const subject = String(raw).trim();
    return validIdentifier(subject) && byteLength(subject) <= 128
      ? subject
      : null;
  };

  const parseAttendanceMarker = (value) => {
    if (value === null || value === undefined || value === "") {
      return { valid: true, checked: false };
    }
    if (
      typeof value !== "string" ||
      value.length > 80 ||
      value.trim() !== value ||
      hasControl(value)
    ) {
      return { valid: false, checked: false };
    }
    return { valid: true, checked: true };
  };

  const normalizeButtonLabel = (value) =>
    (value ?? "").replace(/\s+/gu, " ").trim();

  const buttonLabel = (button) =>
    normalizeButtonLabel(button.getAttribute("aria-label")) ||
    normalizeButtonLabel(button.textContent);

  const handleAttendanceClick = (event) => {
    if (
      !event.isTrusted ||
      window.location.pathname.replace(/\/+$/u, "") !== "/check-in" ||
      !(event.target instanceof Element)
    ) {
      return;
    }
    const clicked = event.target.closest("button");
    if (!(clicked instanceof HTMLButtonElement) || clicked.disabled) return;
    const candidates = Array.from(document.querySelectorAll("button")).filter(
      (button) =>
        button instanceof HTMLButtonElement &&
        buttonLabel(button) === ATTENDANCE_START_LABEL,
    );
    if (
      buttonLabel(clicked) !== ATTENDANCE_START_LABEL ||
      candidates.length !== 1 ||
      candidates[0] !== clicked
    ) {
      return;
    }
    const generation = ++attendanceConfirmationGeneration;
    for (const delayMs of ATTENDANCE_CONFIRMATION_DELAYS_MS) {
      setTimeout(() => {
        if (generation === attendanceConfirmationGeneration) {
          void collect();
        }
      }, delayMs);
    }
  };

  const normalizeCohorts = (value) => {
    if (!Array.isArray(value) || value.length > MAX_COHORTS) return null;
    const ids = new Set();
    const result = [];
    for (const cohort of value) {
      if (
        !isRecord(cohort) ||
        !validIdentifier(cohort.id) ||
        byteLength(cohort.id) > 128 ||
        ids.has(cohort.id)
      ) {
        continue;
      }
      const startDate = normalizeLmsDate(cohort.startDate);
      if (!startDate) continue;
      const hasOpenEnd =
        cohort.endDate === null ||
        cohort.endDate === undefined ||
        cohort.endDate === "";
      const endDate = hasOpenEnd ? null : normalizeLmsDate(cohort.endDate);
      if (!hasOpenEnd && endDate === null) continue;
      if (endDate !== null && endDate < startDate) continue;
      ids.add(cohort.id);
      result.push({
        id: cohort.id,
        startDate,
        endDate,
      });
    }
    return result;
  };

  const compareBoundedEnd = (left, right) => {
    if (left.endDate !== right.endDate) {
      if (left.endDate === null) return 1;
      if (right.endDate === null) return -1;
      const byEnd = left.endDate.localeCompare(right.endDate);
      if (byEnd !== 0) return byEnd;
    }
    return 0;
  };

  const selectCohort = (cohorts, today) => {
    const active = cohorts
      .filter(
        (cohort) =>
          cohort.startDate <= today &&
          (cohort.endDate === null || today <= cohort.endDate),
      )
      .sort(
        (left, right) =>
          compareBoundedEnd(left, right) ||
          right.startDate.localeCompare(left.startDate) ||
          left.id.localeCompare(right.id),
      )[0];
    if (active) {
      return {
        cohortId: active.id,
        cohortStatus: "active",
        cohortStartDate: active.startDate,
        cohortEndDate: active.endDate,
      };
    }

    const upcoming = cohorts
      .filter((cohort) => cohort.startDate > today)
      .sort(
        (left, right) =>
          compareBoundedEnd(left, right) ||
          left.startDate.localeCompare(right.startDate) ||
          left.id.localeCompare(right.id),
      )[0];
    if (upcoming) {
      return {
        cohortId: null,
        cohortStatus: "upcoming",
        cohortStartDate: upcoming.startDate,
        cohortEndDate: upcoming.endDate,
      };
    }

    const ended = cohorts
      .filter(
        (cohort) => cohort.endDate !== null && cohort.endDate < today,
      )
      .sort(
        (left, right) =>
          right.endDate.localeCompare(left.endDate) ||
          right.startDate.localeCompare(left.startDate) ||
          left.id.localeCompare(right.id),
      )[0];
    if (ended) {
      return {
        cohortId: null,
        cohortStatus: "ended",
        cohortStartDate: ended.startDate,
        cohortEndDate: ended.endDate,
      };
    }

    return {
      cohortId: null,
      cohortStatus: cohorts.length === 0 ? "none" : "unknown",
      cohortStartDate: null,
      cohortEndDate: null,
    };
  };

  const fetchLms = async (path, consume) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      LMS_FETCH_TIMEOUT_MS,
    );
    try {
      const response = await fetch(path, {
        credentials: "include",
        headers: { accept: "application/json" },
        cache: "no-store",
        redirect: "follow",
        signal: controller.signal,
      });
      return await consume(response);
    } finally {
      clearTimeout(timeoutId);
    }
  };

  const collect = async () => {
    if (inFlight || window.location.origin !== LMS_ORIGIN) return;
    inFlight = true;
    let subject = null;
    let stage = "me";
    try {
      const me = await fetchLms("/api/v2/me", async (response) => {
        if (isLoginResponse(response)) return { state: "login-required" };
        if (response.status !== 200) return { state: "unavailable" };
        return { state: "available", value: await readJson(response) };
      });
      if (me.state === "login-required") {
        await reportLoginRequired();
        return;
      }
      if (me.state !== "available") {
        await reportDiagnostic("me", "http-unavailable");
        return;
      }
      subject = parseSubject(me.value);
      if (!subject) {
        await reportDiagnostic("me", "invalid-payload");
        return;
      }

      stage = "cohorts";
      const cohortsResult = await fetchLms(
        "/api/v2/me/cohorts",
        async (response) => {
          if (isLoginResponse(response)) return { state: "login-required" };
          if (response.status !== 200) return { state: "unavailable" };
          return { state: "available", value: await readJson(response) };
        },
      );
      if (cohortsResult.state === "login-required") {
        await reportLoginRequired();
        return;
      }
      if (cohortsResult.state !== "available") {
        await reportDiagnostic("cohorts", "http-unavailable");
        await reportSessionConnected(subject);
        return;
      }
      const cohorts = normalizeCohorts(cohortsResult.value);
      if (!cohorts) {
        await reportDiagnostic("cohorts", "invalid-payload");
        await reportSessionConnected(subject);
        return;
      }
      if (cohortsResult.value.length > 0 && cohorts.length === 0) {
        await reportDiagnostic("cohorts", "invalid-payload");
        await reportSessionConnected(subject);
        return;
      }

      const attendanceDate = attendanceDateString(Date.now());
      const selection = selectCohort(cohorts, attendanceDate);
      let morningChecked = false;
      let eveningChecked = false;
      if (selection.cohortStatus === "active") {
        stage = "attendance";
        const attendanceResult = await fetchLms(
          `/api/v2/me/cohorts/${encodeURIComponent(selection.cohortId)}/attendance/today`,
          async (response) => {
            if (isLoginResponse(response)) {
              return { state: "login-required" };
            }
            if (response.status !== 200 && response.status !== 204) {
              return { state: "unavailable" };
            }
            return {
              state: "available",
              value:
                response.status === 204
                  ? null
                  : await readJson(response, true),
            };
          },
        );
        if (attendanceResult.state === "login-required") {
          await reportLoginRequired();
          return;
        }
        if (attendanceResult.state !== "available") {
          await reportDiagnostic("attendance", "http-unavailable");
          await reportSessionConnected(subject);
          return;
        }
        const attendance = attendanceResult.value;
        if (attendance !== null && !isRecord(attendance)) {
          await reportDiagnostic("attendance", "invalid-payload");
          await reportSessionConnected(subject);
          return;
        }
        const morning = parseAttendanceMarker(attendance?.checkedAt);
        const evening = parseAttendanceMarker(attendance?.checkedOutAt);
        if (!morning.valid || !evening.valid) {
          await reportDiagnostic("attendance", "invalid-payload");
          await reportSessionConnected(subject);
          return;
        }
        morningChecked = morning.checked;
        eveningChecked = evening.checked;
        if (morningChecked) {
          attendanceConfirmationGeneration += 1;
        }
      }

      stage = "report";
      try {
        await invokeReport({
          state: "connected",
          subject,
          attendanceDate,
          ...selection,
          morningChecked,
          eveningChecked,
          collectedAt: new Date().toISOString(),
        });
      } catch (error) {
        await reportDiagnostic("report", "report-rejected");
        throw error;
      }
    } catch (_) {
      if (stage !== "report") {
        try {
          await reportDiagnostic(stage, "request-failed");
        } catch (_) {
          // The native retry loop will invoke collection again.
        }
      }
      if (subject) {
        try {
          await reportSessionConnected(subject);
        } catch (_) {
          // The native retry loop will invoke collection again.
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const agent = Object.freeze({ collect });
  Object.defineProperty(window, AGENT_KEY, {
    value: agent,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  document.addEventListener("click", handleAttendanceClick, true);
  void collect();
})();
