fn main() {
    const COMMANDS: &[&str] = &[
        "start_lms_login",
        "clear_local_desktop_session",
        "report_lms_agent_event",
        "send_native_test_notification",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application metadata");
}
