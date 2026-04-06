//! 업데이터 모듈 — 앱 업데이트 확인·설치.
//!
//! GitHub Releases에서 새 버전을 확인하고,
//! 사용자 확인 후 다운로드·설치·재시작을 수행한다.

use std::sync::Arc;

use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::state::AppState;

/// 업데이트를 확인하고 사용자 확인 후 설치하는 공통 로직.
///
/// `silent=true`이면 "최신 버전" / 에러 시 다이얼로그를 표시하지 않음 (시작 시 자동 확인용).
/// `silent=false`이면 모든 결과를 다이얼로그로 표시 (사용자 수동 확인용).
pub(crate) async fn prompt_and_install_update(app: tauri::AppHandle, silent: bool) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::debug!("[updater] updater 초기화 실패: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("[updater] 새 업데이트 발견: v{}", update.version);

            let version = update.version.clone();
            let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
            app.dialog()
                .message(format!(
                    "새로운 버전 v{}이 있습니다. 지금 설치하고 재시작하시겠습니까?",
                    version
                ))
                .title("업데이트 가능")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "설치 및 재시작".into(),
                    "나중에".into(),
                ))
                .show(move |confirmed| {
                    let _ = tx.send(confirmed);
                });
            if rx.await.unwrap_or(false) {
                app.dialog()
                    .message("업데이트를 다운로드 중입니다.\n완료될 때까지 앱을 종료하지 마세요. (이 창은 닫아도 됩니다.)")
                    .title("업데이트 중")
                    .show(|_| {});
                match update.download_and_install(|_, _| {}, || {}).await {
                    Ok(_) => {
                        log::info!("[updater] 업데이트 설치 완료, 앱 재시작");
                        app.restart();
                    }
                    Err(e) => {
                        log::error!("[updater] 업데이트 설치 실패: {}", e);
                        if !silent {
                            app.dialog()
                                .message(format!("업데이트 설치에 실패했습니다: {}", e))
                                .title("업데이트 오류")
                                .show(|_| {});
                        }
                    }
                }
            }
        }
        Ok(None) => {
            log::info!("[updater] 최신 버전입니다");
            if !silent {
                app.dialog()
                    .message("현재 최신 버전입니다.")
                    .title("업데이트 확인")
                    .show(|_| {});
            }
        }
        Err(e) => {
            log::debug!("[updater] 업데이트 확인 실패: {}", e);
            if !silent {
                app.dialog()
                    .message(format!("업데이트 확인에 실패했습니다.\n{}", e))
                    .title("업데이트 확인")
                    .show(|_| {});
            }
        }
    }
}

/// 자동 업데이트 — 업데이트 발견 시 알림 후 즉시 설치·재시작.
///
/// 사용자 확인 없이 자동으로 다운로드·설치하며, 재시작 전에 OS 알림을 발송한다.
pub(crate) async fn auto_install_update(app: tauri::AppHandle) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::debug!("[updater] updater 초기화 실패: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("[updater] 자동 업데이트: v{} 발견, 설치 시작", version);
            let _ = app
                .notification()
                .builder()
                .title("Jungle Bell 업데이트")
                .body(&format!("v{}로 업데이트합니다. 잠시 후 재시작됩니다.", version))
                .show();
            match update.download_and_install(|_, _| {}, || {}).await {
                Ok(_) => {
                    log::info!("[updater] 자동 업데이트 완료, 재시작");
                    app.restart();
                }
                Err(e) => {
                    log::error!("[updater] 자동 업데이트 실패: {}", e);
                }
            }
        }
        Ok(None) => {
            log::debug!("[updater] 자동 업데이트: 최신 버전");
        }
        Err(e) => {
            log::warn!("[updater] 자동 업데이트 확인 실패: {}", e);
        }
    }
}

/// 업데이트 확인 후 `pending_update`에만 저장 — 알림·설치 없음.
///
/// 자동 업데이트가 꺼져 있을 때 주기적 체크 및 시작 시 사용.
/// UI가 `get_pending_update`로 조회해 배너를 표시한다.
pub(crate) async fn check_and_store_pending_update(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::debug!("[updater] updater 초기화 실패: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            log::info!("[updater] 업데이트 발견 (수동): v{}", update.version);
            shared_state.lock().await.pending_update = Some(update.version);
        }
        Ok(None) => {
            log::debug!("[updater] 최신 버전 (수동 체크)");
            shared_state.lock().await.pending_update = None;
        }
        Err(e) => {
            log::warn!("[updater] 업데이트 확인 실패: {}", e);
        }
    }
}

/// 주기적 업데이트 체크.
///
/// - 자동 업데이트 ON: 즉시 다운로드·설치·재시작.
/// - 자동 업데이트 OFF: `pending_update`에 버전 저장 → UI 배너로 표시.
pub(crate) async fn check_update_periodic(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    let auto_update = shared_state.lock().await.config.auto_update;
    if auto_update {
        auto_install_update(app.clone()).await;
    } else {
        check_and_store_pending_update(app, shared_state).await;
    }
}
