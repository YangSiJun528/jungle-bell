// checker.js - API 기반 출석 상태 확인.
// 숨겨진 checker WebView에 initialization_script로 주입.
// DOM 파싱 대신 LMS REST API를 사용하여 안정적으로 상태를 확인한다.

// ─── 외부 API 스키마 (jungle-lms.krafton.com) ───────────────────────────────
// 아래 JSDoc은 현재 의존하는 필드를 문서화한 것.
// API 변경 시 대응 파싱 함수(parseCohorts / parseAttendanceToday)만 수정하면 됨.
//
// API 변경 감지 및 응답 형식 분석은 jungle-campus-analyzer 프로젝트로 관리.
// JS 번들을 역디번들링·정적 분석하여 엔드포인트·ENUM을 추출하고,
// 변경이 감지되면 campus/webcrack/changes/ 에 스냅샷을 저장한다.
//
// GET /api/v2/me/cohorts
/**
 * @typedef {{ id: string, isActive: boolean, startDate: string, endDate: string|null }} Cohort
 * 사용 필드: id, isActive, startDate, endDate (ISO 8601 또는 YYYY-MM-DD)
 */
//
// GET /api/v2/me/cohorts/{cohortId}/attendance/today
/**
 * @typedef {{ checkedAt: string|null, checkedOutAt: string|null }} AttendanceTodayResponse
 * 사용 필드: checkedAt, checkedOutAt (ISO 8601 타임스탬프 or null)
 * 응답 없음(빈 body)은 오늘 출석 기록 없음을 의미.
 */
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var cachedCohortSelection = null;
  var identityReported = false;
  var checkInFlight = false;

  function jsLog(level, message) {
    window.__TAURI__.core.invoke('log_from_js', { level: level, message: message });
  }

  // ─── API 응답 파싱 함수 ──────────────────────────────────────────────────
  // fetch 결과를 앱 내부 표현으로 변환. 외부 API 의존성을 여기에 격리.

  function kstDateStringFromTimestamp(timestamp) {
    return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  function currentKstDateString() {
    return kstDateStringFromTimestamp(Date.now());
  }

  function normalizeDateString(value) {
    if (!value) return null;

    var text = String(value);
    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;

    var match = text.match(/^(\d{4}-\d{2}-\d{2})/);
    var hasExplicitTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(text);
    if (match && !hasExplicitTimezone) return match[1];

    var parsed = new Date(text);
    if (!isNaN(parsed.getTime())) {
      return kstDateStringFromTimestamp(parsed.getTime());
    }

    return match ? match[1] : null;
  }

  function compareCohortDesc(a, b) {
    if (a.start_date !== b.start_date) return a.start_date < b.start_date ? 1 : -1;
    if (a.end_date !== b.end_date) return a.end_date < b.end_date ? 1 : -1;
    return 0;
  }

  /** @param {Cohort[]} cohorts */
  function parseCohorts(cohorts, today) {
    if (!Array.isArray(cohorts) || cohorts.length === 0) {
      return { cohort_id: null, cohort_status: 'none', cohort_end_date: null };
    }

    var normalized = cohorts
      .map(function (cohort) {
        return {
          id: cohort && cohort.id,
          is_active: !!(cohort && cohort.isActive === true),
          start_date: normalizeDateString(cohort && cohort.startDate),
          end_date: normalizeDateString(cohort && cohort.endDate),
        };
      })
      .filter(function (cohort) {
        return cohort.id && cohort.start_date && cohort.end_date;
      });

    var active = normalized
      .filter(function (cohort) {
        return cohort.is_active && cohort.start_date <= today && today <= cohort.end_date;
      })
      .sort(compareCohortDesc);

    if (active.length > 0) {
      return {
        cohort_id: active[0].id,
        cohort_status: 'active',
        cohort_end_date: active[0].end_date,
      };
    }

    var ended = normalized
      .filter(function (cohort) {
        return cohort.end_date < today;
      })
      .sort(function (a, b) {
        if (a.end_date !== b.end_date) return a.end_date < b.end_date ? 1 : -1;
        return compareCohortDesc(a, b);
      });

    return {
      cohort_id: null,
      cohort_status: ended.length > 0 ? 'ended' : 'none',
      cohort_end_date: ended.length > 0 ? ended[0].end_date : null,
    };
  }

  /** @param {AttendanceTodayResponse} data */
  function parseAttendanceToday(data) {
    return {
      morning_done: !!data.checkedAt,
      evening_done: !!data.checkedOutAt,
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  // 사용 통계가 켜져 있으면 /api/v2/me에서 사용자 ID를 가져와 Rust에 보고한다.
  // Rust에서 SHA-256 해시 후 PostHog distinct_id로 사용한다.
  function reportIdentityOnce() {
    if (identityReported) return;

    window.__TAURI__.core.invoke('get_usage_analytics_enabled')
      .then(function (enabled) {
        if (!enabled || identityReported) return null;
        identityReported = true;

        return fetch('https://jungle-lms.krafton.com/api/v2/me', {
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
      })
      .then(function (res) {
        if (!res) return null;
        if (!res.ok) return null;
        return res.json();
      })
      .then(function (data) {
        if (data && data.id) {
          jsLog('debug', 'reportIdentity: id reported');
          window.__TAURI__.core.invoke('report_cms_identity', { cmsUserId: data.id });
        }
      })
      .catch(function (e) {
        jsLog('debug', 'reportIdentity failed: ' + (e.message || e));
        identityReported = false; // 다음 시도 시 재시도
      });
  }

  // /api/v2/me/cohorts에서 현재 날짜 기준 진행 중인 cohort를 선택한다.
  function fetchCohortSelection() {
    var url = 'https://jungle-lms.krafton.com/api/v2/me/cohorts';
    jsLog('debug', 'fetchCohortSelection: GET ' + url);
    return fetch(url, {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
      .then(function (res) {
        jsLog('debug', 'fetchCohortSelection: response status=' + res.status + ' statusText=' + res.statusText);
        if (res.status === 401) {
          jsLog('info', 'fetchCohortSelection: status=401 (login required)');
          return { needs_login: true, cohort_id: null, cohort_status: 'unknown', cohort_end_date: null };
        }
        if (!res.ok) {
          jsLog('warn', 'fetchCohortSelection: status=' + res.status);
          return res.text().then(function (body) {
            jsLog('debug', 'fetchCohortSelection: error body=' + body.substring(0, 500));
            return { api_error: true, cohort_id: null, cohort_status: 'unknown', cohort_end_date: null };
          });
        }
        return res.json().then(function (data) {
          jsLog('debug', 'fetchCohortSelection: raw response=' + JSON.stringify(data).substring(0, 1000));
          return data;
        });
      })
      .then(function (data) {
        if (!data || data.needs_login || data.api_error) return data;
        var today = currentKstDateString();
        var selection = parseCohorts(data, today);
        selection.fetched_date = today;
        jsLog('debug', 'fetchCohortSelection: selected cohortId=' + selection.cohort_id +
          ' status=' + selection.cohort_status +
          ' endDate=' + selection.cohort_end_date +
          ' (total=' + (data.length || 0) + ')');
        return selection;
      })
      .catch(function (e) {
        jsLog('error', 'fetchCohortSelection failed: ' + (e.message || e));
        return { api_error: true, cohort_id: null, cohort_status: 'unknown', cohort_end_date: null };
      });
  }

  // 특정 cohort의 오늘 출석 상태를 조회.
  function fetchAttendance(cohortId) {
    var url = 'https://jungle-lms.krafton.com/api/v2/me/cohorts/' +
      cohortId + '/attendance/today';
    jsLog('debug', 'fetchAttendance: GET ' + url);
    return fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json' },
      }
    )
      .then(function (res) {
        jsLog('debug', 'fetchAttendance: response status=' + res.status + ' statusText=' + res.statusText);
        if (res.status === 401) {
          jsLog('info', 'fetchAttendance: status=401 (login required)');
          return { needs_login: true };
        }
        if (!res.ok) {
          jsLog('warn', 'fetchAttendance: status=' + res.status);
          return res.text().then(function (body) {
            jsLog('debug', 'fetchAttendance: error body=' + body.substring(0, 500));
            return null;
          });
        }
        return res.text().then(function (body) {
          if (!body || body.trim() === '') {
            jsLog('debug', 'fetchAttendance: empty body (no attendance today)');
            return parseAttendanceToday({ checkedAt: null, checkedOutAt: null });
          }
          var data = JSON.parse(body);
          jsLog('debug', 'fetchAttendance: raw response=' + JSON.stringify(data).substring(0, 1000));
          return parseAttendanceToday(data);
        });
      })
      .catch(function (e) {
        jsLog('error', 'fetchAttendance failed: ' + (e.message || e));
        return null;
      });
  }

  function checkAttendance() {
    var currentUrl = window.location.href;
    if (currentUrl.includes('/login')) {
      jsLog('info', 'login required (/login URL detected)');
      return Promise.resolve({
        needs_login: true,
        morning_done: false,
        evening_done: false,
        cohort_status: 'unknown',
        cohort_end_date: null,
      });
    }

    var today = currentKstDateString();
    var cohortPromise = cachedCohortSelection && cachedCohortSelection.fetched_date === today
      ? Promise.resolve(cachedCohortSelection)
      : fetchCohortSelection();

    return cohortPromise.then(function (selection) {
      if (!selection || selection.api_error) {
        return {
          needs_login: false,
          morning_done: false,
          evening_done: false,
          api_error: true,
        };
      }

      if (selection.needs_login) {
        cachedCohortSelection = null;
        return {
          needs_login: true,
          morning_done: false,
          evening_done: false,
          cohort_status: 'unknown',
          cohort_end_date: null,
        };
      }

      cachedCohortSelection = selection;

      if (selection.cohort_status !== 'active' || !selection.cohort_id) {
        return {
          needs_login: false,
          morning_done: false,
          evening_done: false,
          cohort_status: selection.cohort_status,
          cohort_end_date: selection.cohort_end_date,
        };
      }

      reportIdentityOnce();

      return fetchAttendance(selection.cohort_id).then(function (data) {
        if (!data) {
          jsLog('debug', 'checkAttendance: fetchAttendance returned null → api_error');
          // API 오류 — 상태 갱신하지 않도록 표시
          return {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
          };
        }
        if (data.needs_login) {
          jsLog('debug', 'checkAttendance: needs_login flag set, clearing cohort cache');
          cachedCohortSelection = null;
          return {
            needs_login: true,
            morning_done: false,
            evening_done: false,
            cohort_status: 'unknown',
            cohort_end_date: null,
          };
        }
        jsLog('debug', 'checkAttendance: morning_done=' + data.morning_done + ' evening_done=' + data.evening_done);
        return {
          needs_login: false,
          morning_done: data.morning_done,
          evening_done: data.evening_done,
          cohort_status: selection.cohort_status,
          cohort_end_date: selection.cohort_end_date,
        };
      });
    });
  }

  function reportResult(result) {
    jsLog('debug', 'result: needs_login=' + result.needs_login +
      ' morning=' + result.morning_done +
      ' evening=' + result.evening_done +
      ' cohort_status=' + result.cohort_status +
      ' cohort_end_date=' + result.cohort_end_date +
      (result.api_error ? ' api_error=true' : ''));
    window.__TAURI__.core.invoke('report_attendance_status', {
      status: result,
    });
  }

  function runCheck(reason) {
    if (checkInFlight) {
      jsLog('debug', 'check skipped, already running: ' + reason);
      return;
    }

    checkInFlight = true;
    jsLog('debug', 'check started: ' + reason);

    checkAttendance()
      .then(reportResult)
      .finally(function () {
        checkInFlight = false;
      });
  }

  // Rust의 trigger-check 이벤트를 수신하면 API 조회 후 invoke로 반환
  window.__TAURI__.event.listen('trigger-check', function () {
    runCheck('rust-trigger');
  });

  // 초기화 시 즉시 첫 체크 실행 — Rust page-load 이벤트 유실 시에도 초기 상태를 갱신.
  jsLog('info', 'checker.js loaded, running initial check');
  runCheck('initial-load');
})();
