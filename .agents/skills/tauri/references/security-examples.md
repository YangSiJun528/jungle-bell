# Tauri Security Examples Reference

## CVE Details and Mitigations

### CVE-2024-35222: iFrame Origin Bypass

**Severity**: HIGH (CVSS 7.5)
**Affected**: Tauri < 1.6.7, < 2.0.0-beta.20
**CWE**: CWE-346 (Origin Validation Error)

**Description**: When using `dangerousRemoteDomainIpcAccess`, iFrames from the allowed domain could bypass origin checks and invoke Tauri API commands even though they should be restricted to the parent window only.

**Vulnerable Configuration**:
```json
{
  "security": {
    "dangerousRemoteDomainIpcAccess": [
      {
        "domain": "trusted.com",
        "windows": ["main"],
        "enableTauriAPI": true
      }
    ]
  }
}
// Problem: iFrame from trusted.com can invoke Tauri commands
```

**Mitigation**:
1. Upgrade to Tauri 1.6.7+ or 2.0.0-beta.20+
2. Avoid `dangerousRemoteDomainIpcAccess` if possible
3. Implement additional origin checks in commands

```rust
#[command]
async fn sensitive_op(window: Window) -> Result<(), String> {
    // Additional check: reject iFrame origins
    let url = window.url();
    if url.origin() != expected_origin {
        return Err("Invalid origin".into());
    }
    Ok(())
}
```

---

### CVE-2023-46115: Updater Key Leakage via Vite

**Severity**: MEDIUM (CVSS 5.5)
**Affected**: Applications using Vite with misconfigured envPrefix
**CWE**: CWE-200 (Information Exposure)

**Description**: The Tauri documentation example showed `envPrefix: ['VITE_', 'TAURI_']` which causes `TAURI_PRIVATE_KEY` and `TAURI_KEY_PASSWORD` to be bundled into the frontend code.

**Vulnerable Configuration**:
```typescript
// vite.config.ts - VULNERABLE
import { defineConfig } from 'vite';

export default defineConfig({
  envPrefix: ['VITE_', 'TAURI_']  // Leaks TAURI_PRIVATE_KEY!
});
```

**Mitigation**:
```typescript
// vite.config.ts - SECURE
import { defineConfig } from 'vite';

export default defineConfig({
  envPrefix: ['VITE_']  // Only expose VITE_ variables
});
```

**Detection**:
```bash
# Check if keys are in bundle
grep -r "TAURI_PRIVATE_KEY\|TAURI_KEY_PASSWORD" dist/
```

---

### CVE-2023-34460: Filesystem Scope Bypass for Dotfiles

**Severity**: MEDIUM (CVSS 4.7)
**Affected**: Tauri 1.4.0
**CWE**: CWE-22 (Path Traversal)

**Description**: Regression in Tauri 1.4.0 allowed access to dotfiles when using wildcard scopes like `$HOME/*`. Previously dotfiles were not implicitly allowed.

**Vulnerable Scope**:
```json
{
  "fs": {
    "scope": ["$HOME/*"]  // In 1.4.0, this allowed access to ~/.ssh/*
  }
}
```

**Mitigation**:
1. Upgrade to Tauri 1.4.1+
2. Use explicit path allowlists instead of wildcards

```json
// BETTER: Explicit paths
{
  "permissions": [
    {
      "identifier": "fs:read-files",
      "allow": [
        "$HOME/Documents/*",
        "$HOME/Downloads/*"
      ],
      "deny": [
        "$HOME/.*"  // Explicitly deny dotfiles
      ]
    }
  ]
}
```

---

### CVE-2022-46171: Permissive Glob Patterns

**Severity**: HIGH
**Affected**: Tauri < 1.2.3
**CWE**: CWE-22 (Path Traversal)

**Description**: Filesystem scope glob patterns were too permissive, allowing path traversal via symlinks and normalized paths.

**Mitigation**: Always validate and canonicalize paths in backend

```rust
fn validate_in_scope(base_dir: &Path, user_path: &str) -> Result<PathBuf, Error> {
    // Join and canonicalize
    let full = base_dir.join(user_path);
    let canonical = dunce::canonicalize(&full)?;
    let base_canonical = dunce::canonicalize(base_dir)?;

    // Verify containment after resolving symlinks
    if !canonical.starts_with(&base_canonical) {
        return Err(Error::OutOfScope);
    }

    Ok(canonical)
}
```

---

## OWASP Top 10 2025 Complete Examples

### A01: Broken Access Control

```rust
// VULNERABLE: No permission check
#[command]
async fn delete_file(path: String) -> Result<(), String> {
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

// SECURE: Validate scope and permissions
#[command]
async fn delete_file(
    window: Window,
    app: AppHandle,
    request: DeleteRequest,
) -> Result<(), String> {
    // Validate input
    request.validate().map_err(|e| e.to_string())?;

    // Verify origin
    verify_origin(&window)?;

    // Scope to allowed directory
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let safe_path = validate_path(&app_data, &request.path)?;

    // Log action
    tracing::info!(
        action = "delete_file",
        path = %safe_path.display(),
        "File deletion requested"
    );

    std::fs::remove_file(safe_path).map_err(|e| e.to_string())
}
```

### A02: Cryptographic Failures

```rust
// SECURE: Verify update signatures
let updater = app.updater_builder()
    .endpoints(vec!["https://releases.example.com/...".into()])
    .pubkey(include_str!("../pubkey.txt"))  // Embedded public key
    .build()?;

// Verify TLS for all network requests
let client = reqwest::Client::builder()
    .min_tls_version(reqwest::tls::Version::TLS_1_2)
    .danger_accept_invalid_certs(false)  // NEVER set to true
    .build()?;
```

### A03: Injection

```json
// Secure CSP prevents XSS leading to IPC abuse
{
  "security": {
    "csp": {
      "default-src": "'self'",
      "script-src": "'self'",
      "style-src": "'self' 'unsafe-inline'",
      "connect-src": "'self' https://api.example.com",
      "frame-src": "'none'",
      "object-src": "'none'"
    }
  }
}
```

### A05: Security Misconfiguration

```json
// tauri.conf.json - Secure configuration
{
  "app": {
    "security": {
      "csp": "default-src 'self'",
      "freezePrototype": true,
      "dangerousDisableAssetCspModification": false
    }
  },
  "build": {
    "devtools": false  // Disable in production
  }
}
```

```json
// capabilities/default.json - Minimal permissions
{
  "identifier": "default",
  "permissions": [
    "core:event:default",
    "core:window:default"
    // Only add what's needed
  ]
}
```

### A08: Software and Data Integrity Failures

```rust
// Sign releases during CI/CD
// .github/workflows/release.yml
// - uses: tauri-apps/tauri-action@v0
//   with:
//     args: --bundles updater

// Verify integrity in application
async fn verify_download(data: &[u8], expected_hash: &str) -> Result<(), Error> {
    use sha2::{Sha256, Digest};

    let mut hasher = Sha256::new();
    hasher.update(data);
    let hash = hex::encode(hasher.finalize());

    if hash != expected_hash {
        return Err(Error::IntegrityCheck);
    }

    Ok(())
}
```

---

## Additional Security Patterns

### Rate Limiting IPC Commands

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

struct RateLimiter {
    last_reset: std::sync::Mutex<Instant>,
    count: AtomicU64,
    max_per_minute: u64,
}

impl RateLimiter {
    fn check(&self) -> Result<(), Error> {
        let mut last_reset = self.last_reset.lock().unwrap();

        if last_reset.elapsed() > Duration::from_secs(60) {
            *last_reset = Instant::now();
            self.count.store(0, Ordering::SeqCst);
        }

        let count = self.count.fetch_add(1, Ordering::SeqCst);
        if count >= self.max_per_minute {
            return Err(Error::RateLimited);
        }

        Ok(())
    }
}

#[command]
async fn rate_limited_command(
    state: State<'_, AppState>,
) -> Result<String, String> {
    state.rate_limiter.check().map_err(|e| e.to_string())?;
    // ... rest of command
    Ok("success".into())
}
```

### Secure Window Creation

```rust
use tauri::{WebviewUrl, WebviewWindowBuilder};

fn create_secure_window(app: &AppHandle) -> Result<(), Error> {
    WebviewWindowBuilder::new(
        app,
        "secure",
        WebviewUrl::App("index.html".into())
    )
    .title("Secure Window")
    .inner_size(800.0, 600.0)
    .resizable(true)
    // Security settings
    .disable_drag_drop_handler()  // Prevent file drops
    .build()?;

    Ok(())
}
```

### Audit Logging

```rust
use tracing::{info, warn};

#[command]
async fn audited_command(
    window: Window,
    app: AppHandle,
    request: AuditedRequest,
) -> Result<Response, String> {
    let start = std::time::Instant::now();

    // Log request
    info!(
        command = "audited_command",
        window = %window.label(),
        origin = %window.url(),
        request_id = %uuid::Uuid::new_v4(),
        "Command invoked"
    );

    let result = process_request(request).await;

    // Log result
    match &result {
        Ok(_) => info!(
            command = "audited_command",
            duration_ms = %start.elapsed().as_millis(),
            status = "success",
            "Command completed"
        ),
        Err(e) => warn!(
            command = "audited_command",
            duration_ms = %start.elapsed().as_millis(),
            status = "error",
            error = %e,
            "Command failed"
        ),
    }

    result
}
```
