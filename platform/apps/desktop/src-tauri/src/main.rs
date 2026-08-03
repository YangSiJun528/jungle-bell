#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_protocol;
mod desktop_session;
mod installation;
mod native_notification;
mod updater;

use desktop_session::{
    clear_local_desktop_session, initialize_local_agent, is_exact_remote_origin,
    main_privacy_gate_url, open_lms_login, record_main_page_load, report_lms_agent_event,
    request_hide_main, request_show_main, start_lms_login, DesktopSessionState,
};
use native_notification::{
    initialize_native_notifications, send_native_test_notification, NativeNotificationState,
};
use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    plugin::{Builder as PluginBuilder, TauriPlugin},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    Manager, Runtime, Url,
};

const MENU_SHOW: &str = "show";
const MENU_HIDE: &str = "hide";
const MENU_LOGIN: &str = "login";
const MENU_QUIT: &str = "quit";
const LOGIN_WINDOW_LABEL: &str = "lms-login";
const MAIN_WINDOW_LABEL: &str = "main";
const MAIN_CAPABILITY_ID: &str = "main-remote-runtime";
const MAIN_PERMISSIONS: &[&str] = &[
    "allow-start-lms-login",
    "allow-clear-local-desktop-session",
    "allow-send-native-test-notification",
];
const MAIN_PRIVACY_GATE_SCRIPT: &str = r#"
(() => {
  if (window.location.href !== "about:blank") return;
  const render = () => {
    document.documentElement.lang = "ko";
    document.title = "Jungle Bell · LMS 계정 확인";
    const style = document.createElement("style");
    style.textContent = [
      ":root{color-scheme:light dark;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}",
      "body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f8fa;color:#202124}",
      "main{max-width:34rem;padding:2rem;text-align:center}",
      "h1{font-size:1.45rem;margin:0 0 .75rem}",
      "p{font-size:1rem;line-height:1.65;margin:0;color:#5f6368}",
      "@media(prefers-color-scheme:dark){body{background:#17181a;color:#f1f3f4}p{color:#bdc1c6}}"
    ].join("");
    const content = document.createElement("main");
    const heading = document.createElement("h1");
    heading.textContent = "LMS 계정을 확인하고 있습니다";
    const explanation = document.createElement("p");
    explanation.textContent =
      "개인 정보 보호를 위해 현재 LMS 계정 확인이 끝날 때까지 이전 화면을 표시하지 않습니다.";
    content.append(heading, explanation);
    document.head.replaceChildren(style);
    document.body.replaceChildren(content);
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render, { once: true });
  } else {
    render();
  }
})();
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TrayAction {
    Show,
    Hide,
    Login,
    Quit,
    Ignore,
}

fn tray_menu_action(id: &str) -> TrayAction {
    match id {
        MENU_SHOW => TrayAction::Show,
        MENU_HIDE => TrayAction::Hide,
        MENU_LOGIN => TrayAction::Login,
        MENU_QUIT => TrayAction::Quit,
        _ => TrayAction::Ignore,
    }
}

fn remote_capability_pattern(origin: &Url) -> String {
    format!("{}*", origin.as_str())
}

fn is_allowed_webview_navigation(label: &str, url: &Url, app_origin: &Url) -> bool {
    match label {
        LOGIN_WINDOW_LABEL => is_allowed_login_navigation(url),
        MAIN_WINDOW_LABEL => {
            url.as_str() == main_privacy_gate_url().as_str()
                || is_exact_remote_origin(url, app_origin)
        }
        _ => false,
    }
}

fn is_allowed_login_navigation(url: &Url) -> bool {
    url.as_str() == "about:blank"
        || (url.scheme() == "https"
            && matches!(
                url.host_str(),
                Some("jungle-lms.krafton.com" | "accounts.google.com")
            )
            && url.port_or_known_default() == Some(443)
            && url.username().is_empty()
            && url.password().is_none())
}

fn navigation_guard<R: Runtime>(app_origin: Url) -> TauriPlugin<R> {
    PluginBuilder::new("remote-navigation-guard")
        .on_navigation(move |webview, url| {
            let allowed = is_allowed_webview_navigation(webview.label(), url, &app_origin);
            if cfg!(debug_assertions) {
                eprintln!(
                    "webview-navigation label={} scheme={} host={} allowed={allowed}",
                    webview.label(),
                    url.scheme(),
                    url.host_str().unwrap_or("<none>"),
                );
            }
            allowed
        })
        .build()
}

fn add_main_capability<R: Runtime>(app: &tauri::App<R>, app_origin: &Url) -> tauri::Result<()> {
    let capability = MAIN_PERMISSIONS.iter().fold(
        CapabilityBuilder::new(MAIN_CAPABILITY_ID)
            .local(false)
            .remote(remote_capability_pattern(app_origin))
            .window(MAIN_WINDOW_LABEL),
        |capability, permission| capability.permission(*permission),
    );
    app.add_capability(capability)
}

fn initial_main_webview_url() -> tauri::WebviewUrl {
    tauri::WebviewUrl::External(main_privacy_gate_url())
}

fn build_main_window(app: &tauri::App) -> tauri::Result<tauri::WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW_LABEL, initial_main_webview_url())
        .title("Jungle Bell")
        .inner_size(1100.0, 760.0)
        .min_inner_size(760.0, 560.0)
        .center()
        .resizable(true)
        .fullscreen(false)
        .visible(false)
        .focused(false)
        .devtools(false)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_page_load(|window, payload| {
            record_main_page_load(window.app_handle(), payload.url(), payload.event());
        })
        .initialization_script(MAIN_PRIVACY_GATE_SCRIPT)
        .build()
}

fn show_main_window(app: &tauri::AppHandle) {
    request_show_main(app);
}

fn hide_main_window(app: &tauri::AppHandle) {
    request_hide_main(app);
}

fn handle_second_instance(app: &tauri::AppHandle) {
    request_show_main(app);
}

fn main() {
    let desktop_session =
        DesktopSessionState::configured().expect("failed to initialize desktop session state");
    let app_origin = desktop_session.app_origin().clone();
    let setup_origin = app_origin.clone();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            handle_second_instance(app);
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(desktop_session)
        .manage(NativeNotificationState::default())
        .plugin(navigation_guard(app_origin))
        .invoke_handler(tauri::generate_handler![
            start_lms_login,
            clear_local_desktop_session,
            report_lms_agent_event,
            send_native_test_notification,
        ])
        .setup(move |app| {
            add_main_capability(app, &setup_origin)?;
            build_main_window(app)?;

            let show = MenuItem::with_id(app, MENU_SHOW, "Jungle Bell 열기", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, MENU_HIDE, "창 숨기기", true, None::<&str>)?;
            let login = MenuItem::with_id(app, MENU_LOGIN, "LMS 로그인 열기", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, MENU_QUIT, "종료", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &hide, &login, &quit])?;

            let mut tray = TrayIconBuilder::with_id("main-tray")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .tooltip("Jungle Bell")
                .on_menu_event(|app, event| match tray_menu_action(event.id().as_ref()) {
                    TrayAction::Show => show_main_window(app),
                    TrayAction::Hide => hide_main_window(app),
                    TrayAction::Login => {
                        let app = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = open_lms_login(&app).await;
                        });
                    }
                    TrayAction::Quit => app.exit(0),
                    TrayAction::Ignore => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            initialize_native_notifications(app.handle());
            initialize_local_agent(app).map_err(std::io::Error::other)?;
            updater::spawn_startup_update_check(app.handle().clone());
            show_main_window(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == LOGIN_WINDOW_LABEL {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.hide();
                }
                return;
            }
            if window.label() != MAIN_WINDOW_LABEL {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                hide_main_window(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("failed to run Jungle Bell desktop shell");
}

#[cfg(test)]
mod tests {
    use super::{
        initial_main_webview_url, is_allowed_webview_navigation, remote_capability_pattern,
        tray_menu_action, TrayAction, MAIN_CAPABILITY_ID, MAIN_PERMISSIONS,
        MAIN_PRIVACY_GATE_SCRIPT, MENU_HIDE, MENU_LOGIN, MENU_QUIT, MENU_SHOW,
    };
    use crate::desktop_session::{is_exact_remote_origin, main_privacy_gate_url};
    use tauri::Url;

    #[test]
    fn maps_only_known_tray_menu_items() {
        assert_eq!(tray_menu_action(MENU_SHOW), TrayAction::Show);
        assert_eq!(tray_menu_action(MENU_HIDE), TrayAction::Hide);
        assert_eq!(tray_menu_action(MENU_LOGIN), TrayAction::Login);
        assert_eq!(tray_menu_action(MENU_QUIT), TrayAction::Quit);
        assert_eq!(tray_menu_action("open-lms"), TrayAction::Ignore);
        assert_eq!(tray_menu_action(""), TrayAction::Ignore);
    }

    #[test]
    fn main_privacy_gate_is_the_only_non_remote_main_navigation() {
        let trusted = Url::parse("https://bell.example.com").expect("trusted origin");
        assert_eq!(main_privacy_gate_url().as_str(), "about:blank");
        match initial_main_webview_url() {
            tauri::WebviewUrl::External(url) => {
                assert_eq!(url, main_privacy_gate_url());
                assert!(!is_exact_remote_origin(&url, &trusted));
            }
            _ => panic!("the main WebView must boot at the native privacy gate"),
        }
        assert!(is_allowed_webview_navigation(
            "main",
            &main_privacy_gate_url(),
            &trusted
        ));
        for url in [
            "about:blank#remote-user",
            "about:srcdoc",
            "data:text/html,old-dashboard",
            "file:///tmp/dashboard.html",
        ] {
            assert!(!is_allowed_webview_navigation(
                "main",
                &Url::parse(url).expect("candidate URL"),
                &trusted
            ));
        }
        let source = include_str!("main.rs");
        assert!(
            source.contains(".visible(false)"),
            "the main WebView must not flash its initial surface before setup applies the gate"
        );
    }

    #[test]
    fn privacy_gate_script_is_static_and_has_no_remote_or_native_data_access() {
        for required in [
            r#"window.location.href !== "about:blank""#,
            "LMS 계정을 확인하고 있습니다",
            "개인 정보 보호를 위해",
        ] {
            assert!(MAIN_PRIVACY_GATE_SCRIPT.contains(required), "{required}");
        }
        for forbidden in [
            "fetch(",
            "XMLHttpRequest",
            "__TAURI__",
            "localStorage",
            "sessionStorage",
            "document.cookie",
        ] {
            assert!(!MAIN_PRIVACY_GATE_SCRIPT.contains(forbidden), "{forbidden}");
        }
    }

    #[test]
    fn remote_main_navigation_requires_the_exact_trusted_origin() {
        let trusted = Url::parse("https://bell.example.com").expect("trusted origin");
        for url in [
            "https://bell.example.com/",
            "https://bell.example.com/settings?tab=notifications#desktop",
        ] {
            assert!(is_allowed_webview_navigation(
                "main",
                &Url::parse(url).expect("candidate URL"),
                &trusted
            ));
        }
        for url in [
            "http://bell.example.com/",
            "https://bell.example.com:8443/",
            "https://bell.example.com.evil.test/",
            "https://user@bell.example.com/",
        ] {
            assert!(!is_allowed_webview_navigation(
                "main",
                &Url::parse(url).expect("candidate URL"),
                &trusted
            ));
        }
    }

    #[test]
    fn login_window_allows_only_exact_https_auth_hosts_and_about_blank() {
        let app_origin = Url::parse("https://bell.example.com").expect("app origin");
        for url in [
            "https://jungle-lms.krafton.com/login",
            "https://accounts.google.com/v3/signin/identifier",
            "about:blank",
        ] {
            assert!(is_allowed_webview_navigation(
                "lms-login",
                &Url::parse(url).expect("auth URL"),
                &app_origin
            ));
        }
        for url in [
            "http://jungle-lms.krafton.com/login",
            "https://user:password@accounts.google.com/",
            "https://accounts.google.com.evil.test/",
            "https://evil.example/",
            "about:srcdoc",
            "about:blank#fragment",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/html,hello",
        ] {
            assert!(!is_allowed_webview_navigation(
                "lms-login",
                &Url::parse(url).expect("blocked auth URL"),
                &app_origin
            ));
        }
    }

    #[test]
    fn lms_login_window_is_an_owned_popup_of_the_main_window() {
        let source = include_str!("desktop_session.rs");
        for required in [
            "get_webview_window(MAIN_WINDOW_LABEL)",
            ".parent(&main)",
            ".maximizable(false)",
            ".minimizable(false)",
        ] {
            assert!(
                source.contains(required),
                "the LMS login window must keep the popup contract: {required}"
            );
        }
    }

    #[test]
    fn runtime_main_capability_is_remote_and_minimal() {
        let origin = Url::parse("https://bell.example.com").expect("app origin");
        assert_eq!(MAIN_CAPABILITY_ID, "main-remote-runtime");
        assert_eq!(
            remote_capability_pattern(&origin),
            "https://bell.example.com/*"
        );
        assert_eq!(
            MAIN_PERMISSIONS,
            &[
                "allow-start-lms-login",
                "allow-clear-local-desktop-session",
                "allow-send-native-test-notification"
            ]
        );
    }

    #[test]
    fn config_does_not_create_a_bundled_or_local_main_window() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        assert_eq!(config["app"]["windows"], serde_json::json!([]));
        assert!(config["build"].get("frontendDist").is_none());
    }

    #[test]
    fn config_freezes_the_custom_protocol_object_prototype() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        assert_eq!(
            config["app"]["security"]["freezePrototype"],
            serde_json::json!(true)
        );
    }

    #[test]
    fn platform_desktop_is_an_in_place_renewal_of_the_legacy_installation() {
        let platform_config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let legacy_config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../src-tauri/tauri.conf.json"))
                .expect("valid legacy Tauri config");

        assert_eq!(platform_config["identifier"], legacy_config["identifier"]);
        assert_eq!(platform_config["productName"], legacy_config["productName"]);
        assert_eq!(legacy_config["version"], serde_json::json!("0.4.4"));
        assert_eq!(platform_config["version"], serde_json::json!("0.5.0"));
        assert_eq!(env!("CARGO_PKG_VERSION"), "0.5.0");

        let stable_version = |value: &serde_json::Value| {
            value
                .as_str()
                .expect("stable version string")
                .split('.')
                .map(|part| part.parse::<u64>().expect("numeric version component"))
                .collect::<Vec<_>>()
        };
        assert!(
            stable_version(&platform_config["version"]) > stable_version(&legacy_config["version"])
        );
    }

    #[test]
    fn workspace_versions_are_locked_to_the_desktop_release_version() {
        for package in [
            include_str!("../../../../package.json"),
            include_str!("../../../api/package.json"),
            include_str!("../../package.json"),
            include_str!("../../../web/package.json"),
        ] {
            let package: serde_json::Value =
                serde_json::from_str(package).expect("valid workspace package");
            assert_eq!(package["version"], serde_json::json!("0.5.0"));
        }

        let lock: serde_json::Value =
            serde_json::from_str(include_str!("../../../../package-lock.json"))
                .expect("valid workspace lockfile");
        assert_eq!(lock["version"], serde_json::json!("0.5.0"));
        for workspace in ["", "apps/api", "apps/desktop", "apps/web"] {
            assert_eq!(
                lock["packages"][workspace]["version"],
                serde_json::json!("0.5.0"),
                "{workspace}"
            );
        }
    }

    #[test]
    fn updater_keeps_the_legacy_trust_root_and_runs_only_from_rust() {
        let platform_config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("valid Tauri config");
        let legacy_config: serde_json::Value =
            serde_json::from_str(include_str!("../../../../../src-tauri/tauri.conf.json"))
                .expect("valid legacy Tauri config");
        assert_eq!(
            platform_config["plugins"]["updater"], legacy_config["plugins"]["updater"],
            "an installed 0.4.4 client and the renewed app must trust the same signed feed"
        );
        assert_eq!(
            platform_config["bundle"]["createUpdaterArtifacts"],
            serde_json::json!(true)
        );

        let cargo = include_str!("../Cargo.toml");
        assert!(cargo.contains("tauri-plugin-updater = \"=2.10.1\""));
        let source = include_str!("main.rs");
        assert!(source.contains(".plugin(tauri_plugin_updater::Builder::new().build())"));
        assert!(source.contains("updater::spawn_startup_update_check(app.handle().clone())"));
        assert!(
            MAIN_PERMISSIONS
                .iter()
                .all(|permission| !permission.contains("updater")),
            "the remote dashboard must not receive updater IPC authority"
        );
    }

    #[test]
    fn remote_login_capability_exposes_only_the_normalized_agent_callback() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/lms-login.json"))
                .expect("valid login capability");
        assert_eq!(capability["local"], false);
        assert_eq!(capability["windows"], serde_json::json!(["lms-login"]));
        assert_eq!(
            capability["remote"]["urls"],
            serde_json::json!(["https://jungle-lms.krafton.com/*"])
        );
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-report-lms-agent-event"])
        );
    }

    #[test]
    fn desktop_has_no_bearer_persistence_dependencies_or_commands() {
        let cargo = include_str!("../Cargo.toml");
        for dependency in ["keyring", "zeroize"] {
            assert!(!cargo.contains(dependency));
        }
        let build = include_str!("../build.rs");
        for removed in [
            "get_desktop_auth_status",
            "disconnect_lms",
            "create_mobile_pairing",
            "get_mobile_pairing_status",
            "approve_mobile_pairing",
        ] {
            assert!(!build.contains(removed));
        }
    }

    #[test]
    fn single_instance_plugin_prevents_duplicate_collectors_and_reveals_main() {
        let source = include_str!("main.rs");
        let registration = source
            .find(".plugin(tauri_plugin_single_instance::init")
            .expect("single-instance plugin registration");
        let managed_state = source
            .find(".manage(desktop_session)")
            .expect("desktop session registration");
        assert!(registration < managed_state);
        assert!(source.contains(
            "fn handle_second_instance(app: &tauri::AppHandle) {\n    request_show_main(app);\n}"
        ));

        let cargo = include_str!("../Cargo.toml");
        assert!(cargo.contains("tauri-plugin-single-instance"));
    }
}
