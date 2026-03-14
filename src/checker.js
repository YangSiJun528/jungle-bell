// checker.js - API 기반 출석 상태 확인.
// 숨겨진 checker WebView에 initialization_script로 주입.
// DOM 파싱 대신 LMS REST API를 사용하여 안정적으로 상태를 확인한다.

(function () {
  var cachedCohortId = null;

  function jsLog(level, message) {
    window.__TAURI__.core.invoke('log_from_js', { level: level, message: message });
  }

  // /api/v2/me/cohorts에서 cohort 목록을 가져와
  // startDate가 가장 최신인 cohort의 ID를 반환.
  function fetchCohortId() {
    return fetch('https://jungle-lms.krafton.com/api/v2/me/cohorts', {
      credentials: 'include',
      headers: { accept: 'application/json' },
    })
      .then(function (res) {
        if (res.status === 401) {
          jsLog('info', 'fetchCohortId: status=401 (login required)');
          return null;
        }
        if (!res.ok) {
          jsLog('warn', 'fetchCohortId: status=' + res.status);
          return null;
        }
        return res.json();
      })
      .then(function (cohorts) {
        if (!cohorts || !Array.isArray(cohorts) || cohorts.length === 0)
          return null;
        cohorts.sort(function (a, b) {
          return new Date(b.startDate) - new Date(a.startDate);
        });
        var id = cohorts[0].id;
        jsLog('debug', 'fetchCohortId: ok, cohortId=' + id);
        return id;
      })
      .catch(function (e) {
        jsLog('error', 'fetchCohortId failed: ' + (e.message || e));
        return null;
      });
  }

  // 특정 cohort의 오늘 출석 상태를 조회.
  function fetchAttendance(cohortId) {
    return fetch(
      'https://jungle-lms.krafton.com/api/v2/me/cohorts/' +
        cohortId +
        '/attendance/today',
      {
        credentials: 'include',
        headers: { accept: 'application/json' },
      }
    )
      .then(function (res) {
        if (res.status === 401) {
          jsLog('info', 'fetchAttendance: status=401 (login required)');
          return { needs_login: true };
        }
        if (!res.ok) {
          jsLog('warn', 'fetchAttendance: status=' + res.status);
          return null;
        }
        jsLog('debug', 'fetchAttendance: status=200');
        return res.json();
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
      });
    }

    var cohortPromise = cachedCohortId
      ? Promise.resolve(cachedCohortId)
      : fetchCohortId();

    return cohortPromise.then(function (cohortId) {
      if (!cohortId) {
        return { needs_login: true, morning_done: false, evening_done: false };
      }
      cachedCohortId = cohortId;

      return fetchAttendance(cohortId).then(function (data) {
        if (!data) {
          // API 오류 — 상태 갱신하지 않도록 표시
          return {
            needs_login: false,
            morning_done: false,
            evening_done: false,
            api_error: true,
          };
        }
        if (data.needs_login) {
          cachedCohortId = null;
          return { needs_login: true, morning_done: false, evening_done: false };
        }
        return {
          needs_login: false,
          morning_done: !!data.checkedAt,
          evening_done: !!data.checkedOutAt,
        };
      });
    });
  }

  function reportResult(result) {
    jsLog('debug', 'result: needs_login=' + result.needs_login +
      ' morning=' + result.morning_done +
      ' evening=' + result.evening_done +
      (result.api_error ? ' api_error=true' : ''));
    window.__TAURI__.core.invoke('report_attendance_status', {
      status: result,
    });
  }

  // Rust의 trigger-check 이벤트를 수신하면 API 조회 후 invoke로 반환
  window.__TAURI__.event.listen('trigger-check', function () {
    checkAttendance().then(reportResult);
  });

  // 초기화 시 즉시 첫 체크 실행 — 스케줄러 이벤트 유실 방지
  jsLog('info', 'checker.js loaded, running initial check');
  checkAttendance().then(reportResult);
})();
