// checker.js - Pure DOM snapshot collector for attendance page.
// Injected as initialization_script into the checker WebView.
// Rust가 'trigger-check' 이벤트를 보내면 DOM 스냅샷을 수집해 invoke로 반환.

(function () {
  function readAttendanceTable() {
    var result = { morning_done: false, evening_done: false };
    var rows = document.querySelectorAll(
      'table[data-slot="table"] tbody tr'
    );
    if (!rows || rows.length === 0) return result;
    var cells = rows[0].querySelectorAll('td');
    if (cells.length < 4) return result;

    var startText = cells[2].textContent.trim();
    var endText = cells[3].textContent.trim();
    var timePattern = /\d{1,2}:\d{2}/;
    result.morning_done = timePattern.test(startText);
    result.evening_done = timePattern.test(endText);
    return result;
  }

  function collectSnapshot() {
    var currentUrl = window.location.href;
    var isLoginPage = currentUrl.includes('/login');

    if (isLoginPage) {
      return {
        needs_login: true,
        button_text: null,
        is_disabled: false,
        morning_done: false,
        evening_done: false,
        page_url: currentUrl,
        page_not_ready: false,
      };
    }

    var table = readAttendanceTable();
    var btn = document.querySelector('button[data-variant="destructive"]');
    var buttonText = btn ? btn.textContent.trim() : null;
    var isDisabled = btn ? btn.hasAttribute('disabled') : false;

    var rows = document.querySelectorAll('table[data-slot="table"] tbody tr');
    var pageNotReady = (!rows || rows.length === 0) && !btn;

    return {
      needs_login: false,
      button_text: buttonText,
      is_disabled: isDisabled,
      morning_done: table.morning_done,
      evening_done: table.evening_done,
      page_url: currentUrl,
      page_not_ready: pageNotReady,
    };
  }

  // Rust의 trigger-check 이벤트를 수신하면 스냅샷 수집 후 invoke로 반환
  window.__TAURI__.event.listen('trigger-check', function () {
    var result = collectSnapshot();
    window.__TAURI__.core.invoke('report_attendance_status', { status: result });
  });
})();
