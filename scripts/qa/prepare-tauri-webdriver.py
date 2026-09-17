#!/usr/bin/env python3
"""Create an isolated macOS QA copy; the application sources remain unchanged."""

import argparse
import json
from pathlib import Path
import shutil
import sys
import uuid


def replace_once(path, before, after):
    text = path.read_text()
    if text.count(before) != 1:
        raise RuntimeError(f"Source changed; review QA instrumentation: {path.name}")
    path.write_text(text.replace(before, after, 1))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New directory outside the repository")
    parser.add_argument("--port", type=int, default=4445)
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This isolation procedure is verified only on macOS")
    if not 1024 <= args.port <= 65535:
        parser.error("Choose a port between 1024 and 65535")
    repo = Path(__file__).resolve().parents[2]
    output = args.output.resolve()
    if output.exists() or output.is_relative_to(repo):
        parser.error("Output must be a new directory outside the repository")
    frontend = repo / "frontend/dist/desktop"
    if not (frontend / "index.html").is_file():
        parser.error("Run frontend build:desktop-ui first")
    output.mkdir(parents=True)
    desktop = output / "desktop"
    shutil.copytree(repo / "desktop", desktop, ignore=shutil.ignore_patterns("target", "gen", ".DS_Store"))
    shutil.copytree(frontend, output / "frontend/dist/desktop")
    token = uuid.uuid4().hex[:12]
    identifier = f"dev.sijun-yang.jungle-bell.qa.{token}"
    product = f"Jungle Bell QA {token}"
    config_path = desktop / "tauri.conf.json"
    config = json.loads(config_path.read_text())
    config.update(identifier=identifier, productName=product)
    config["build"].pop("beforeBuildCommand", None)
    config["bundle"]["createUpdaterArtifacts"] = False
    config["bundle"]["targets"] = ["app"]
    # Installing a production update would discard this copy's isolation.
    config["plugins"]["updater"]["endpoints"] = []
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n")

    replace_once(desktop / "Cargo.toml", "[features]\n", '[features]\nqa-webdriver = ["dep:tauri-plugin-wdio-webdriver"]\n')
    replace_once(desktop / "Cargo.toml", "[dependencies]\n", '[dependencies]\ntauri-plugin-wdio-webdriver = { version = "=1.4.0", optional = true }\n')
    lib = desktop / "src/lib.rs"
    replace_once(lib, "    tauri::Builder::default()\n", "    let builder = tauri::Builder::default()\n")
    replace_once(lib, '            tray::open_dashboard_window(app);\n        }))\n',
                 '            tray::open_dashboard_window(app);\n        }));\n'
                 '    #[cfg(all(debug_assertions, feature = "qa-webdriver"))]\n'
                 f'    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init_with_port({args.port}));\n'
                 '    builder\n')
    # A failed/disabled update check blocks the UI. Keep this one result explicit
    # and deterministic; updates themselves are outside this UI QA's scope.
    replace_once(desktop / "src/updater.rs",
                 '    ) -> Result<CheckedUpdate, String> {\n        if !force {',
                 '    ) -> Result<CheckedUpdate, String> {\n'
                 '        if cfg!(all(debug_assertions, feature = "qa-webdriver")) {\n'
                 '            let status = DesktopUpdateStatus::new(app.package_info().version.to_string(), None);\n'
                 '            self.publish_status(status.clone());\n'
                 '            return Ok(CheckedUpdate { status, update: None });\n'
                 '        }\n'
                 '        if !force {')
    local_state = output / "state"
    local_state.mkdir()
    replace_once(desktop / "src/config.rs",
                 'dirs::config_dir().map(|path| path.join("jungle-bell").join(CURRENT_CONFIG_FILE_NAME))',
                 f'Some(PathBuf::from({json.dumps(str(local_state), ensure_ascii=False)}).join(CURRENT_CONFIG_FILE_NAME))')
    (local_state / "desktop-settings.json").write_text(json.dumps({
        "schema": "jungle-bell.desktop-settings", "schemaVersion": 6,
        "settings": {"autoStart": False, "usageAnalytics": False,
                     "debugMode": False, "selectedCohortId": None},
    }, indent=2) + "\n")
    # This QA checks fresh UI/IPC; it does not test saved LMS sessions.
    for filename, title in [("checker.rs", "Jungle Campus"), ("tray.rs", "Jungle Bell")]:
        replace_once(desktop / "src" / filename, f'    .title("{title}")\n',
                     f'    .incognito(true)\n    .title("{title}")\n')
    metadata = {"identifier": identifier, "productName": product, "port": args.port,
                "source": str(repo), "desktop": str(desktop),
                "configDirectory": str(local_state), "webviews": "nonpersistent",
                "updater": "fixture: latest, no download/install"}
    (output / "qa-environment.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
