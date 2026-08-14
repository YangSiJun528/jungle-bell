use tauri_plugin_autostart::ManagerExt as AutostartManagerExt;

/// Config 값을 기준으로 OS 자동 시작 상태를 동기화한다.
pub fn sync_auto_start(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let autolaunch = app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };

    result.map_err(|e| e.to_string())
}
