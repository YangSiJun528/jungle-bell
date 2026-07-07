# Tauri Threat Model

## Threat Model Overview

**Domain Risk Level**: HIGH

### Assets to Protect
1. **User Data** - Application data, credentials, personal files - **Sensitivity**: CRITICAL
2. **System Access** - Filesystem, shell, network - **Sensitivity**: CRITICAL
3. **Update Mechanism** - Application integrity - **Sensitivity**: HIGH
4. **IPC Channel** - Communication between frontend and backend - **Sensitivity**: HIGH

### Threat Actors
1. **Malicious Websites** - XSS, CSRF via embedded content
2. **Supply Chain Attackers** - Compromised dependencies, malicious updates
3. **Local Attackers** - Users with system access trying to escalate privileges
4. **Network Attackers** - MitM on updates, API hijacking

### Attack Surface
- WebView content (XSS, injection)
- IPC commands from frontend
- Filesystem access patterns
- Auto-update mechanism
- Plugin system
- Window management

---

## Attack Scenario 1: IPC Command Injection via XSS

**Threat Category**: OWASP A03:2025 - Injection / CWE-94

**Threat Level**: CRITICAL

**Attack Description**: Attacker injects malicious JavaScript into the WebView, which then calls Tauri IPC commands to access system resources.

**Attack Flow**:
```
1. Application loads external content or user-provided HTML
2. Attacker injects: <script>window.__TAURI__.invoke('read_file', {path: '/etc/passwd'})</script>
3. Malicious script executes in WebView context
4. IPC command is invoked with attacker-controlled parameters
5. Backend executes command without origin verification
6. Attacker exfiltrates sensitive system files
```

**Impact**:
- **Confidentiality**: CRITICAL - Full filesystem access
- **Integrity**: HIGH - Can modify files
- **Availability**: MEDIUM - Can delete files
- **Business Impact**: Complete system compromise

**Likelihood**: HIGH - XSS is common in web applications

**Mitigation**:

```rust
// Primary: Origin verification for all sensitive commands
#[command]
async fn read_file(window: Window, request: FileRequest) -> Result<String, String> {
    // Verify origin
    let url = window.url();
    if !url.as_str().starts_with("tauri://") && !url.as_str().starts_with("https://tauri.localhost") {
        return Err("Invalid origin".into());
    }

    // Validate and scope path
    request.validate()?;
    // ... rest of implementation
}
```

```json
// Secondary: Restrictive CSP
{
  "security": {
    "csp": "default-src 'self'; script-src 'self'; frame-src 'none'"
  }
}
```

**Detection**:
```rust
// Log all IPC calls
tracing::info!(
    command = "read_file",
    origin = %window.url(),
    path = %request.path,
    "IPC command invoked"
);
```

---

## Attack Scenario 2: Filesystem Scope Escape via Path Traversal

**Threat Category**: OWASP A01:2025 - Broken Access Control / CWE-22

**Threat Level**: CRITICAL

**Attack Description**: Attacker bypasses filesystem scope restrictions using path traversal sequences to access files outside allowed directories.

**Attack Flow**:
```
1. Application allows read access to $APPDATA/myapp/*
2. Attacker requests path: "../../.ssh/id_rsa"
3. Path joins to: $APPDATA/myapp/../../.ssh/id_rsa
4. Resolves to: ~/.ssh/id_rsa (outside scope!)
5. Application reads and returns private SSH key
6. Attacker steals credentials
```

**Impact**:
- **Confidentiality**: CRITICAL - Access to any user file
- **Integrity**: HIGH - Can write to any user file
- **Business Impact**: Credential theft, data exfiltration

**Likelihood**: HIGH - Simple attack, CVE-2023-34460 and CVE-2022-46171 show history

**Mitigation**:

```rust
use std::path::PathBuf;

fn validate_path(base: &PathBuf, user_path: &str) -> Result<PathBuf, Error> {
    // Reject obvious traversal attempts
    if user_path.contains("..") {
        return Err(Error::PathTraversal);
    }

    let full_path = base.join(user_path);

    // Canonicalize to resolve symlinks and normalize
    let canonical = dunce::canonicalize(&full_path)
        .map_err(|_| Error::NotFound)?;

    let base_canonical = dunce::canonicalize(base)
        .map_err(|_| Error::Configuration)?;

    // Verify containment
    if !canonical.starts_with(&base_canonical) {
        return Err(Error::PathTraversal);
    }

    Ok(canonical)
}
```

**Testing**:
```rust
#[test]
fn test_path_traversal_variants() {
    let base = PathBuf::from("/app/data");
    let attacks = vec![
        "../etc/passwd",
        "..\\etc\\passwd",
        "foo/../../../etc/passwd",
        "foo/bar/../../../etc/passwd",
        "./../../etc/passwd",
        "%2e%2e/etc/passwd",
    ];

    for attack in attacks {
        assert!(validate_path(&base, attack).is_err(),
            "Path traversal not blocked: {}", attack);
    }
}
```

---

## Attack Scenario 3: Update Mechanism Compromise

**Threat Category**: OWASP A08:2025 - Software and Data Integrity Failures / CWE-494

**Threat Level**: CRITICAL

**Attack Description**: Attacker compromises update server or performs MitM to deliver malicious application update.

**Attack Flow**:
```
1. Attacker compromises update server or DNS
2. Application checks for updates
3. Malicious update served instead of legitimate one
4. If signatures not verified, malicious update installs
5. Attacker gains persistent code execution
6. Complete system compromise
```

**Impact**:
- **Confidentiality**: CRITICAL - Full system access
- **Integrity**: CRITICAL - Persistent malware
- **Availability**: CRITICAL - Ransomware potential
- **Business Impact**: Complete compromise of all users

**Likelihood**: MEDIUM - Requires server compromise, but CVE-2023-46115 shows key leakage risk

**Mitigation**:

```rust
// Mandatory signature verification
let updater = app.updater_builder()
    .endpoints(vec![
        "https://releases.example.com/{{target}}/{{arch}}/{{current_version}}".into()
    ])
    // Public key for signature verification
    .pubkey("dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkK...")
    .build()?;

// Never disable signature verification
// updater.dangerous_skip_signature_validation() // NEVER DO THIS
```

```typescript
// Protect private keys - vite.config.ts
export default {
    envPrefix: ['VITE_']  // NOT ['VITE_', 'TAURI_']
}
```

**Key Management**:
- Store private key in secure vault (not in repo)
- Rotate keys annually
- Use HSM for production signing
- Monitor for key leakage

---

## Attack Scenario 4: iFrame Origin Bypass (CVE-2024-35222)

**Threat Category**: OWASP A01:2025 - Broken Access Control / CWE-346

**Threat Level**: HIGH

**Attack Description**: Malicious iFrame from remote origin bypasses Tauri API access controls to invoke commands.

**Attack Flow**:
```
1. Application embeds content with dangerousRemoteDomainIpcAccess
2. Attacker controls or compromises allowed remote domain
3. Attacker adds iFrame to their content
4. iFrame inherits IPC access from parent
5. iFrame origin not properly checked
6. Attacker invokes Tauri commands from iFrame
```

**Impact**:
- **Confidentiality**: HIGH - Access to IPC commands
- **Integrity**: HIGH - Can invoke state-changing commands
- **Business Impact**: Unauthorized access to system resources

**Likelihood**: MEDIUM - Requires specific configuration

**Mitigation**:

```json
// Avoid dangerousRemoteDomainIpcAccess if possible
{
  "security": {
    // Don't use this unless absolutely necessary
    // "dangerousRemoteDomainIpcAccess": []
  }
}

// If required, upgrade to patched version
// Tauri 1.6.7+ or 2.0.0-beta.20+
```

```rust
// Additional origin check in commands
#[command]
async fn sensitive_command(window: Window) -> Result<(), String> {
    let url = window.url();

    // Reject if from iframe (check for expected top-level URL)
    if !is_top_level_window(&window) {
        return Err("Command not allowed from iframe".into());
    }

    Ok(())
}
```

---

## Attack Scenario 5: Shell Command Injection

**Threat Category**: OWASP A03:2025 - Injection / CWE-78

**Threat Level**: CRITICAL

**Attack Description**: Attacker exploits shell execution capability to run arbitrary system commands.

**Attack Flow**:
```
1. Application has shell:allow-execute capability
2. User input passed to shell command
3. Attacker provides: filename; rm -rf /
4. Command constructed: open "filename; rm -rf /"
5. Shell interprets ; as command separator
6. Malicious command executes with app privileges
```

**Impact**:
- **Confidentiality**: CRITICAL - Can read any file
- **Integrity**: CRITICAL - Can modify/delete any file
- **Availability**: CRITICAL - Can destroy system
- **Business Impact**: Complete system compromise

**Likelihood**: HIGH if shell execution enabled

**Mitigation**:

```json
// Best: Don't enable shell execution
{
  "permissions": [
    // "shell:allow-execute"  // DISABLED
  ]
}

// If required: Strict allowlist with fixed arguments
{
  "permissions": [
    {
      "identifier": "shell:allow-execute",
      "allow": [
        {
          "name": "open-browser",
          "cmd": "open",
          "args": [
            { "validator": "^https://example\\.com" }
          ]
        }
      ]
    }
  ]
}
```

```rust
// Rust backend: Never use shell
use std::process::Command;

// NEVER
Command::new("sh").arg("-c").arg(format!("open {}", user_input));

// ALWAYS - direct execution with validation
fn open_url(url: &str) -> Result<(), Error> {
    // Validate URL format
    let parsed = url::Url::parse(url)
        .map_err(|_| Error::InvalidUrl)?;

    // Allowlist schemes
    if parsed.scheme() != "https" {
        return Err(Error::InvalidScheme);
    }

    // Allowlist domains
    if parsed.host_str() != Some("example.com") {
        return Err(Error::InvalidDomain);
    }

    Command::new("open")
        .arg(url)
        .spawn()
        .map_err(|e| Error::Command(e))?;

    Ok(())
}
```

---

## STRIDE Analysis

| Category | Threats | Mitigations | Priority |
|----------|---------|-------------|----------|
| **Spoofing** | Fake origin in IPC, compromised update server | Origin verification, update signatures | CRITICAL |
| **Tampering** | Modified filesystem paths, injected commands | Path validation, input sanitization | CRITICAL |
| **Repudiation** | No audit trail for sensitive operations | Log all IPC calls with context | MEDIUM |
| **Information Disclosure** | Path traversal, verbose errors | Path containment, safe error messages | HIGH |
| **Denial of Service** | Resource exhaustion via IPC | Rate limiting, input size limits | MEDIUM |
| **Elevation of Privilege** | Shell injection, capability abuse | Disable shell, minimal capabilities | CRITICAL |

---

## Security Testing Coverage

### Automated Testing
- [ ] Path traversal fuzzing on all file operations
- [ ] IPC command fuzzing with invalid inputs
- [ ] CSP validation in browser devtools
- [ ] Dependency scanning with cargo-audit

### Manual Testing
- [ ] Origin verification bypass attempts
- [ ] Update mechanism MitM testing
- [ ] Capability escalation testing
- [ ] Shell injection in allowed commands

### Penetration Testing Scope
- [ ] WebView XSS leading to IPC abuse
- [ ] Filesystem scope escape
- [ ] Update integrity verification
- [ ] Plugin security boundaries
