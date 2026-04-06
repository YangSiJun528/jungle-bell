//! 업데이터 모듈 — 앱 업데이트 확인·설치.
//!
//! GitHub Releases에서 새 버전을 확인하고,
//! 사용자 확인 후 다운로드·설치·재시작을 수행한다.

use std::sync::Arc;

use chrono::{Timelike, Utc};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::Mutex;

use crate::state::AppState;

/// 알림을 보내는 KST 시작 시각 (11시 이상)
const NOTIFY_HOUR_START_KST: u32 = 11;
/// 알림을 보내는 KST 종료 시각 (22시 미만)
const NOTIFY_HOUR_END_KST: u32 = 22;
/// 같은 버전에 대한 알림 재발송 최소 간격 (4시간)
const NOTIFY_COOLDOWN_SECS: i64 = 4 * 60 * 60;

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

/// 주기적 업데이트 체크 — OS 알림 전용, 다이얼로그 없음.
///
/// 업데이트 발견 시 `state.pending_update`에 버전을 저장하고,
/// KST 11:00~22:00 사이일 때만 OS 알림을 발송한다.
/// 최신 버전이면 `pending_update`를 클리어한다.
pub(crate) async fn check_update_periodic(app: &tauri::AppHandle, shared_state: &Arc<Mutex<AppState>>) {
    let auto_update = shared_state.lock().await.config.auto_update;
    if !auto_update {
        return;
    }

    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log::debug!("[updater] 주기적 체크: updater 초기화 실패: {}", e);
            return;
        }
    };

    match updater.check().await {
        Ok(Some(update)) => {
            let version = update.version.clone();
            log::info!("[updater] 주기적 체크: 새 업데이트 발견 v{}", version);
            shared_state.lock().await.pending_update = Some(version.clone());

            // KST 시간 확인 (11:00~22:00만 알림 발송)
            let kst_now = Utc::now().with_timezone(&crate::state::kst());
            let hour = kst_now.hour();
            if hour < NOTIFY_HOUR_START_KST || hour >= NOTIFY_HOUR_END_KST {
                log::info!("[updater] 주기적 체크: 알림 시간 아님 ({}시, KST {}~{}시만 발송)", hour, NOTIFY_HOUR_START_KST, NOTIFY_HOUR_END_KST);
                return;
            }

            // 4시간 쿨다운: 같은 버전에 대해 너무 자주 알림 보내지 않음
            let last_notif = shared_state.lock().await.last_update_notification;
            if let Some(last) = last_notif {
                let elapsed = Utc::now().signed_duration_since(last).num_seconds();
                if elapsed < NOTIFY_COOLDOWN_SECS {
                    log::info!("[updater] 주기적 체크: 쿨다운 중 ({}초 남음)", NOTIFY_COOLDOWN_SECS - elapsed);
                    return;
                }
            }

            shared_state.lock().await.last_update_notification = Some(Utc::now());
            let _ = app
                .notification()
                .builder()
                .title("Jungle Bell 업데이트 알림")
                .body(&format!("v{} 업데이트가 있습니다. 설정에서 확인하세요.", version))
                .show();
            log::info!("[updater] 주기적 업데이트 알림 발송: v{}", version);
        }
        Ok(None) => {
            log::debug!("[updater] 주기적 체크: 최신 버전");
            shared_state.lock().await.pending_update = None;
        }
        Err(e) => {
            log::warn!("[updater] 주기적 체크 실패: {}", e);
        }
    }
}
