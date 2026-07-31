import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(
  new URL("../src/lms_collector.js", import.meta.url),
  "utf8",
);

const response = (status, value, path) => ({
  status,
  url: `https://jungle-lms.krafton.com${path}`,
  text: async () => (value === null ? "" : JSON.stringify(value)),
});

const flushTasks = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

const createHarness = ({
  attendance = null,
  buttons = [],
  cohorts = [],
  nowEpochMs = Date.now(),
  stalledFetchCall,
}) => {
  const reports = [];
  const scheduledAttendanceCallbacks = [];
  const clickListeners = [];
  let fetchCalls = 0;
  let timeoutCalls = 0;
  let resolveAbort;
  const aborted = new Promise((resolve) => {
    resolveAbort = resolve;
  });

  const fetch = (path, options) => {
    fetchCalls += 1;
    if (fetchCalls === stalledFetchCall) {
      return new Promise((_, reject) => {
        const rejectAbort = () => {
          resolveAbort();
          const error = new Error("request timed out");
          error.name = "AbortError";
          reject(error);
        };
        if (options.signal.aborted) {
          rejectAbort();
        } else {
          options.signal.addEventListener("abort", rejectAbort, { once: true });
        }
      });
    }
    if (path === "/api/v2/me") {
      return Promise.resolve(response(200, { id: "lms-user-42" }, path));
    }
    if (path === "/api/v2/me/cohorts") {
      return Promise.resolve(response(200, cohorts, path));
    }
    if (path.includes("/attendance/today")) {
      return Promise.resolve(response(200, attendance, path));
    }
    throw new Error(`unexpected path: ${path}`);
  };

  const window = {
    location: {
      origin: "https://jungle-lms.krafton.com",
      pathname: "/check-in",
    },
    __TAURI__: {
      core: {
        invoke: async (command, payload) => {
          assert.equal(command, "report_lms_agent_event");
          reports.push(JSON.parse(payload.report));
        },
      },
    },
  };
  class HarnessElement {
    closest(selector) {
      return selector === "button" && this instanceof HarnessButton
        ? this
        : null;
    }
  }
  class HarnessButton extends HarnessElement {
    constructor(label, disabled = false) {
      super();
      this.textContent = label;
      this.disabled = disabled;
    }

    getAttribute() {
      return null;
    }
  }
  const buttonElements = buttons.map(
    (button) =>
      new HarnessButton(
        typeof button === "string" ? button : button.label,
        typeof button === "string" ? false : button.disabled,
      ),
  );
  const document = {
    addEventListener(type, listener, capture) {
      if (type === "click") {
        assert.equal(capture, true);
        clickListeners.push(listener);
      }
    },
    querySelectorAll(selector) {
      assert.equal(selector, "button");
      return buttonElements;
    },
  };
  class HarnessDate extends Date {
    constructor(value) {
      super(value === undefined ? nowEpochMs : value);
    }

    static now() {
      return nowEpochMs;
    }
  }

  const context = vm.createContext({
    AbortController,
    Date: HarnessDate,
    Element: HarnessElement,
    HTMLButtonElement: HarnessButton,
    TextEncoder,
    URL,
    clearTimeout: () => {},
    document,
    encodeURIComponent,
    fetch,
    setTimeout: (callback, timeoutMs) => {
      if (timeoutMs !== 12_000) {
        scheduledAttendanceCallbacks.push(callback);
        return `attendance-${scheduledAttendanceCallbacks.length}`;
      }
      timeoutCalls += 1;
      assert.equal(timeoutMs, 12_000);
      if (timeoutCalls === stalledFetchCall) queueMicrotask(callback);
      return timeoutCalls;
    },
    unescape,
    window,
  });
  vm.runInContext(script, context);

  return {
    aborted,
    agent: window.__JUNGLE_BELL_LMS_AGENT__,
    clickButton: (index, trusted = true) => {
      for (const listener of clickListeners) {
        listener({ isTrusted: trusted, target: buttonElements[index] });
      }
    },
    fetchCallCount: () => fetchCalls,
    reports,
    runNextAttendanceTimer: () =>
      scheduledAttendanceCallbacks.shift()?.(),
    scheduledAttendanceTimerCount: () =>
      scheduledAttendanceCallbacks.length,
  };
};

test("a timed-out first request releases inFlight and never reports login-required", async () => {
  const harness = createHarness({ stalledFetchCall: 1 });
  await harness.aborted;
  await flushTasks();

  assert.deepEqual(harness.reports, [
    {
      state: "collector-diagnostic",
      stage: "me",
      reason: "request-failed",
    },
  ]);
  await harness.agent.collect();

  assert.equal(harness.fetchCallCount(), 3);
  assert.equal(
    harness.reports.some((report) => report.state === "login-required"),
    false,
  );
  assert.equal(harness.reports.at(-1)?.state, "connected");
});

test("a timeout after identity verification reports a transient connected session", async () => {
  const harness = createHarness({ stalledFetchCall: 2 });
  await harness.aborted;
  await flushTasks();

  assert.equal(
    harness.reports.some((report) => report.state === "login-required"),
    false,
  );
  assert.deepEqual(harness.reports, [
    {
      state: "collector-diagnostic",
      stage: "cohorts",
      reason: "request-failed",
    },
    { state: "session-connected", subject: "lms-user-42" },
  ]);
});

test("uses the previous KST attendance day until the 04:00 rollover", async () => {
  const beforeRollover = createHarness({
    nowEpochMs: Date.parse("2026-08-01T03:59:59+09:00"),
  });
  await flushTasks();
  assert.equal(beforeRollover.reports.at(-1)?.attendanceDate, "2026-07-31");

  const atRollover = createHarness({
    nowEpochMs: Date.parse("2026-08-01T04:00:00+09:00"),
  });
  await flushTasks();
  assert.equal(atRollover.reports.at(-1)?.attendanceDate, "2026-08-01");
});

test("matches the legacy collector by skipping malformed cohorts and not requiring isActive", async () => {
  const harness = createHarness({
    nowEpochMs: Date.parse("2026-07-31T12:00:00+09:00"),
    cohorts: [
      {
        id: "active-cohort",
        startDate: "2026-07-01T00:00:00",
        endDate: "2026-08-31T23:59:59",
      },
      { id: 7, startDate: "2026-07-01", endDate: "2026-08-31" },
      { id: "missing-start-date", endDate: "2026-08-31" },
      {
        id: "invalid-range",
        startDate: "2026-09-01",
        endDate: "2026-08-01",
      },
    ],
    attendance: {
      checkedAt: "server-defined-truthy-value",
      checkedOutAt: null,
    },
  });
  await flushTasks();

  assert.equal(harness.fetchCallCount(), 3);
  assert.deepEqual(harness.reports.at(-1), {
    state: "connected",
    subject: "lms-user-42",
    attendanceDate: "2026-07-31",
    cohortId: "active-cohort",
    cohortStatus: "active",
    cohortStartDate: "2026-07-01",
    cohortEndDate: "2026-08-31",
    morningChecked: true,
    eveningChecked: false,
    collectedAt: "2026-07-31T03:00:00.000Z",
  });
});

test("treats an empty legacy endDate as an open-ended cohort", async () => {
  const harness = createHarness({
    nowEpochMs: Date.parse("2026-07-31T12:00:00+09:00"),
    cohorts: [
      {
        id: "open-ended",
        isActive: "true",
        startDate: "2026-07-01",
        endDate: "",
      },
    ],
  });
  await flushTasks();

  assert.equal(harness.reports.at(-1)?.state, "connected");
  assert.equal(harness.reports.at(-1)?.cohortId, "open-ended");
  assert.equal(harness.reports.at(-1)?.cohortEndDate, null);
});

test("rejects non-string attendance markers instead of coercing them", async () => {
  const harness = createHarness({
    nowEpochMs: Date.parse("2026-07-31T12:00:00+09:00"),
    cohorts: [
      {
        id: "active-cohort",
        startDate: "2026-07-01",
        endDate: "2026-08-31",
      },
    ],
    attendance: {
      checkedAt: true,
      checkedOutAt: 1,
    },
  });
  await flushTasks();

  assert.deepEqual(harness.reports, [
    {
      state: "collector-diagnostic",
      stage: "attendance",
      reason: "invalid-payload",
    },
    { state: "session-connected", subject: "lms-user-42" },
  ]);
});

test("rechecks attendance after one exact trusted 학습 시작 click", async () => {
  const harness = createHarness({
    nowEpochMs: Date.parse("2026-07-31T12:00:00+09:00"),
    buttons: ["  학습\n시작  ", "학습 종료"],
    cohorts: [
      {
        id: "active-cohort",
        startDate: "2026-07-01",
        endDate: "2026-08-31",
      },
    ],
  });
  await flushTasks();
  const initialFetches = harness.fetchCallCount();

  harness.clickButton(0);
  assert.equal(harness.scheduledAttendanceTimerCount(), 5);
  harness.runNextAttendanceTimer();
  await flushTasks();

  assert.equal(harness.fetchCallCount(), initialFetches + 3);
  assert.equal(harness.reports.at(-1)?.state, "connected");
});

test("ignores synthetic, ambiguous, and non-exact attendance clicks", async () => {
  for (const testCase of [
    { buttons: ["학습 시작"], index: 0, trusted: false },
    { buttons: ["학습 시작", "학습 시작"], index: 0, trusted: true },
    { buttons: ["학습 시작하기"], index: 0, trusted: true },
    {
      buttons: [{ label: "학습 시작", disabled: true }],
      index: 0,
      trusted: true,
    },
  ]) {
    const harness = createHarness(testCase);
    await flushTasks();
    harness.clickButton(testCase.index, testCase.trusted);
    assert.equal(harness.scheduledAttendanceTimerCount(), 0);
  }
});
