//! 설치 식별자와 Jungle Bell 데스크톱 세션을 위한 로컬 저장소 경계.
//!
//! LMS cookie/token은 이 모듈에 전달하거나 저장하지 않는다. 서버가 발급한
//! 불투명한 Jungle Bell 세션은 macOS Keychain 또는 Windows Credential Manager에
//! 저장한다. 설치 식별자는 앱 전용 데이터 디렉터리의 mode 0600 파일에 유지한다.
//! 과거 세션 파일은 keyring 저장 성공 뒤 한 번만 제거한다.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Arc,
};

use zeroize::Zeroizing;

const INSTALLATION_ID_FILE: &str = "desktop-installation-id-v1";
const MAX_INSTALLATION_ID_BYTES: u64 = 64;
const DESKTOP_SESSION_FILE: &str = "desktop-app-session-v1";
const DESKTOP_SESSION_TEMP_PREFIX: &str = ".desktop-app-session-v1.";
const MAX_DESKTOP_SESSION_BYTES: u64 = 512;
const KEYRING_SERVICE: &str = "dev.sijun-yang.jungle-bell";
const KEYRING_ACCOUNT: &str = "desktop-app-session";

pub(crate) trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str>;
    fn load_validated(
        &self,
        _validate: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<Option<Zeroizing<String>>, &'static str> {
        self.load()
    }
    fn store(&self, value: &str) -> Result<(), &'static str>;
    fn clear(&self) -> Result<(), &'static str>;
    fn is_persistent(&self) -> bool {
        true
    }
}

trait SecretBackend: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str>;
    fn store(&self, value: &str) -> Result<(), &'static str>;
    fn clear(&self) -> Result<(), &'static str>;
}

struct SystemSecretBackend;

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SystemSecretBackend {
    fn entry() -> Result<keyring::Entry, &'static str> {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT).map_err(|_| "CREDENTIAL_STORAGE_FAILED")
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
impl SecretBackend for SystemSecretBackend {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        match Self::entry()?.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err("CREDENTIAL_LOAD_FAILED"),
        }
    }

    fn store(&self, value: &str) -> Result<(), &'static str> {
        Self::entry()?
            .set_password(value)
            .map_err(|_| "CREDENTIAL_STORE_FAILED")
    }

    fn clear(&self) -> Result<(), &'static str> {
        match Self::entry()?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("CREDENTIAL_CLEAR_FAILED"),
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
impl SecretBackend for SystemSecretBackend {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        Err("CREDENTIAL_STORAGE_UNAVAILABLE")
    }

    fn store(&self, _value: &str) -> Result<(), &'static str> {
        Err("CREDENTIAL_STORAGE_UNAVAILABLE")
    }

    fn clear(&self) -> Result<(), &'static str> {
        Err("CREDENTIAL_STORAGE_UNAVAILABLE")
    }
}

/// Stores the desktop session in the operating system credential vault.
///
/// The file store is retained only as a one-time reader/remover for releases
/// that predate the keyring migration. New credentials are never written there.
pub(crate) struct KeyringCredentialStore {
    backend: Arc<dyn SecretBackend>,
    legacy: FileCredentialStore,
}

impl KeyringCredentialStore {
    pub(crate) fn new(app_data_dir: &Path) -> Result<Self, &'static str> {
        Self::with_backend(app_data_dir, Arc::new(SystemSecretBackend))
    }

    fn with_backend(app_data_dir: &Path, backend: Arc<dyn SecretBackend>) -> Result<Self, &'static str> {
        Ok(Self {
            backend,
            legacy: FileCredentialStore::new(app_data_dir)?,
        })
    }

    fn cleanup_legacy_temps_best_effort(&self) {
        if let Err(error) = self.legacy.clear_orphaned_temps() {
            log::warn!("[connected-service] legacy credential temp cleanup deferred: {error}");
        }
    }

    fn finish_validated_keyring_load(&self) {
        if let Err(error) = self.legacy.clear() {
            log::warn!("[connected-service] validated keyring credential kept; legacy cleanup deferred: {error}");
        }
        self.cleanup_legacy_temps_best_effort();
    }

    fn finish_validated_legacy_load(&self, value: &str) {
        match self.backend.store(value) {
            Ok(()) => {
                if let Err(error) = self.legacy.clear() {
                    log::warn!(
                        "[connected-service] migrated keyring credential kept; legacy cleanup deferred: {error}"
                    );
                }
            }
            Err(error) => {
                log::warn!("[connected-service] legacy credential kept; keyring migration deferred: {error}");
            }
        }
        self.cleanup_legacy_temps_best_effort();
    }
}

impl CredentialStore for KeyringCredentialStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        let loaded = match self.backend.load()? {
            Some(value) => {
                validate_stored_value(&value)?;
                Some(value)
            }
            None => self.legacy.load()?,
        };
        self.cleanup_legacy_temps_best_effort();
        Ok(loaded)
    }

    fn load_validated(
        &self,
        validate: &(dyn Fn(&str) -> bool + Send + Sync),
    ) -> Result<Option<Zeroizing<String>>, &'static str> {
        match self.backend.load() {
            Ok(Some(keyring_value)) if validate(&keyring_value) => {
                self.finish_validated_keyring_load();
                Ok(Some(keyring_value))
            }
            Ok(Some(keyring_value)) => match self.legacy.load() {
                Ok(Some(legacy_value)) if validate(&legacy_value) => {
                    self.finish_validated_legacy_load(&legacy_value);
                    Ok(Some(legacy_value))
                }
                Ok(_) => {
                    self.cleanup_legacy_temps_best_effort();
                    Ok(Some(keyring_value))
                }
                Err(error) => {
                    self.cleanup_legacy_temps_best_effort();
                    Err(error)
                }
            },
            Ok(None) => {
                let legacy_value = self.legacy.load()?;
                if let Some(value) = legacy_value.as_deref().filter(|value| validate(value)) {
                    self.finish_validated_legacy_load(value);
                } else {
                    self.cleanup_legacy_temps_best_effort();
                }
                Ok(legacy_value)
            }
            Err(keyring_error) => match self.legacy.load() {
                Ok(Some(legacy_value)) if validate(&legacy_value) => {
                    log::warn!(
                        "[connected-service] validated legacy credential used while keyring is unavailable: {keyring_error}"
                    );
                    self.cleanup_legacy_temps_best_effort();
                    Ok(Some(legacy_value))
                }
                _ => {
                    self.cleanup_legacy_temps_best_effort();
                    Err(keyring_error)
                }
            },
        }
    }

    fn store(&self, value: &str) -> Result<(), &'static str> {
        validate_stored_value(value)?;
        self.backend.store(value)?;
        let legacy_result = self.legacy.clear();
        let temp_result = self.legacy.clear_orphaned_temps();
        if legacy_result.is_err() || temp_result.is_err() {
            return Err("CREDENTIAL_CLEAR_FAILED");
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), &'static str> {
        let backend_result = self.backend.clear();
        let legacy_result = self.legacy.clear();
        let temp_result = self.legacy.clear_orphaned_temps();
        if backend_result.is_err() || legacy_result.is_err() || temp_result.is_err() {
            Err("CREDENTIAL_CLEAR_FAILED")
        } else {
            Ok(())
        }
    }
}

struct FileCredentialStore {
    directory: PathBuf,
    path: PathBuf,
}

impl FileCredentialStore {
    fn new(app_data_dir: &Path) -> Result<Self, &'static str> {
        fs::create_dir_all(app_data_dir).map_err(|_| "CREDENTIAL_STORAGE_FAILED")?;
        let metadata = fs::symlink_metadata(app_data_dir).map_err(|_| "CREDENTIAL_STORAGE_FAILED")?;
        if !metadata.file_type().is_dir() {
            return Err("CREDENTIAL_STORAGE_FAILED");
        }
        Ok(Self {
            directory: app_data_dir.to_path_buf(),
            path: app_data_dir.join(DESKTOP_SESSION_FILE),
        })
    }

    fn clear_orphaned_temps(&self) -> Result<(), &'static str> {
        let entries = fs::read_dir(&self.directory).map_err(|_| "CREDENTIAL_CLEAR_FAILED")?;
        let mut removed_any = false;
        for entry in entries {
            let entry = entry.map_err(|_| "CREDENTIAL_CLEAR_FAILED")?;
            if !is_legacy_session_temp_name(&entry.file_name()) {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|_| "CREDENTIAL_CLEAR_FAILED")?;
            validate_private_session_file(&metadata)?;
            fs::remove_file(path).map_err(|_| "CREDENTIAL_CLEAR_FAILED")?;
            removed_any = true;
        }
        if removed_any {
            sync_directory(&self.directory).map_err(|_| "CREDENTIAL_CLEAR_FAILED")?;
        }
        Ok(())
    }
}

impl CredentialStore for FileCredentialStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("CREDENTIAL_LOAD_FAILED"),
        };
        validate_private_session_file(&metadata)?;
        let bytes = Zeroizing::new(fs::read(&self.path).map_err(|_| "CREDENTIAL_LOAD_FAILED")?);
        if bytes.is_empty() || bytes.len() as u64 > MAX_DESKTOP_SESSION_BYTES {
            return Err("CREDENTIAL_VALUE_INVALID");
        }
        let value = std::str::from_utf8(&bytes).map_err(|_| "CREDENTIAL_VALUE_INVALID")?;
        validate_stored_value(value)?;
        Ok(Some(Zeroizing::new(value.to_owned())))
    }

    fn store(&self, value: &str) -> Result<(), &'static str> {
        validate_stored_value(value)?;
        if let Ok(metadata) = fs::symlink_metadata(&self.path) {
            validate_private_session_file(&metadata)?;
        }

        let temp_path = self.directory.join(format!(
            "{DESKTOP_SESSION_TEMP_PREFIX}{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        let result = write_private_temp(&temp_path, value)
            .and_then(|_| replace_session_file(&temp_path, &self.path))
            .and_then(|_| sync_directory(&self.directory));
        if result.is_err() {
            let _ = fs::remove_file(&temp_path);
            return Err("CREDENTIAL_STORE_FAILED");
        }
        Ok(())
    }

    fn clear(&self) -> Result<(), &'static str> {
        match fs::symlink_metadata(&self.path) {
            Ok(metadata) => {
                validate_private_session_file(&metadata)?;
                fs::remove_file(&self.path).map_err(|_| "CREDENTIAL_CLEAR_FAILED")?;
                sync_directory(&self.directory).map_err(|_| "CREDENTIAL_CLEAR_FAILED")
            }
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
            Err(_) => Err("CREDENTIAL_CLEAR_FAILED"),
        }
    }
}

fn validate_stored_value(value: &str) -> Result<(), &'static str> {
    if value.is_empty()
        || value.len() as u64 > MAX_DESKTOP_SESSION_BYTES
        || !value.starts_with('{')
        || !value.ends_with('}')
        || value.chars().any(char::is_control)
    {
        return Err("CREDENTIAL_VALUE_INVALID");
    }
    Ok(())
}

fn is_legacy_session_temp_name(name: &std::ffi::OsStr) -> bool {
    let Some(name) = name.to_str() else {
        return false;
    };
    let Some(identifier) = name
        .strip_prefix(DESKTOP_SESSION_TEMP_PREFIX)
        .and_then(|value| value.strip_suffix(".tmp"))
    else {
        return false;
    };
    identifier.len() == 32
        && identifier
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_private_session_file(metadata: &fs::Metadata) -> Result<(), &'static str> {
    if !metadata.file_type().is_file() || metadata.len() > MAX_DESKTOP_SESSION_BYTES {
        return Err("CREDENTIAL_FILE_INVALID");
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err("CREDENTIAL_FILE_INVALID");
        }
    }
    Ok(())
}

fn write_private_temp(path: &Path, value: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()
}

#[cfg(unix)]
fn replace_session_file(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}

#[cfg(windows)]
fn replace_session_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if to.exists() {
        fs::remove_file(to)?;
    }
    fs::rename(from, to)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    std::fs::File::open(path)?.sync_all()
}

#[cfg(windows)]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InstallationIdentity {
    pub(crate) id: String,
    pub(crate) newly_created: bool,
}

pub(crate) fn load_or_create_installation_identity(app_data_dir: &Path) -> Result<InstallationIdentity, &'static str> {
    fs::create_dir_all(app_data_dir).map_err(|_| "INSTALLATION_STORAGE_FAILED")?;
    let path = app_data_dir.join(INSTALLATION_ID_FILE);
    match read_installation_id(&path) {
        Ok(value) => {
            return Ok(InstallationIdentity {
                id: value,
                newly_created: false,
            })
        }
        Err(InstallationReadError::Missing) => {}
        Err(InstallationReadError::Invalid) => return Err("INSTALLATION_ID_INVALID"),
        Err(InstallationReadError::Storage) => return Err("INSTALLATION_STORAGE_FAILED"),
    }

    let generated = uuid::Uuid::new_v4().hyphenated().to_string();
    match create_installation_id(&path, &generated) {
        Ok(()) => Ok(InstallationIdentity {
            id: generated,
            newly_created: true,
        }),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            let id = read_installation_id(&path).map_err(|error| match error {
                InstallationReadError::Invalid => "INSTALLATION_ID_INVALID",
                InstallationReadError::Missing | InstallationReadError::Storage => "INSTALLATION_STORAGE_FAILED",
            })?;
            Ok(InstallationIdentity {
                id,
                newly_created: false,
            })
        }
        Err(_) => Err("INSTALLATION_STORAGE_FAILED"),
    }
}

pub(crate) fn reset_installation_identity(app_data_dir: &Path) -> Result<InstallationIdentity, &'static str> {
    let path = app_data_dir.join(INSTALLATION_ID_FILE);
    match fs::symlink_metadata(&path) {
        Ok(metadata) => {
            validate_installation_file(&metadata).map_err(|_| "INSTALLATION_ID_INVALID")?;
            fs::remove_file(&path).map_err(|_| "INSTALLATION_STORAGE_FAILED")?;
            sync_directory(app_data_dir).map_err(|_| "INSTALLATION_STORAGE_FAILED")?;
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => return Err("INSTALLATION_STORAGE_FAILED"),
    }
    load_or_create_installation_identity(app_data_dir)
}

pub(crate) fn parse_installation_id(value: &str) -> Result<String, &'static str> {
    let parsed = uuid::Uuid::parse_str(value).map_err(|_| "INSTALLATION_ID_INVALID")?;
    let canonical = parsed.hyphenated().to_string();
    if value == canonical {
        Ok(canonical)
    } else {
        Err("INSTALLATION_ID_INVALID")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InstallationReadError {
    Missing,
    Invalid,
    Storage,
}

fn read_installation_id(path: &Path) -> Result<String, InstallationReadError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            InstallationReadError::Missing
        } else {
            InstallationReadError::Storage
        }
    })?;
    validate_installation_file(&metadata).map_err(|_| InstallationReadError::Invalid)?;
    let value = fs::read_to_string(path).map_err(|_| InstallationReadError::Storage)?;
    parse_installation_id(&value).map_err(|_| InstallationReadError::Invalid)
}

fn validate_installation_file(metadata: &fs::Metadata) -> Result<(), ()> {
    if !metadata.file_type().is_file() || metadata.len() > MAX_INSTALLATION_ID_BYTES {
        return Err(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o777 != 0o600 {
            return Err(());
        }
    }
    Ok(())
}

fn create_installation_id(path: &Path, value: &str) -> std::io::Result<()> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(value.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
pub(crate) struct MemoryCredentialStore {
    value: std::sync::Mutex<Option<String>>,
}

#[cfg(test)]
impl MemoryCredentialStore {
    pub(crate) fn new(value: Option<&str>) -> Self {
        Self {
            value: std::sync::Mutex::new(value.map(str::to_owned)),
        }
    }
}

#[cfg(test)]
impl CredentialStore for MemoryCredentialStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        Ok(self
            .value
            .lock()
            .map_err(|_| "CREDENTIAL_LOAD_FAILED")?
            .clone()
            .map(Zeroizing::new))
    }

    fn store(&self, value: &str) -> Result<(), &'static str> {
        *self.value.lock().map_err(|_| "CREDENTIAL_STORE_FAILED")? = Some(value.to_owned());
        Ok(())
    }

    fn clear(&self) -> Result<(), &'static str> {
        *self.value.lock().map_err(|_| "CREDENTIAL_CLEAR_FAILED")? = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    struct TestSecretBackend {
        value: Mutex<Option<String>>,
        fail_store: AtomicBool,
        fail_clear: AtomicBool,
    }

    impl TestSecretBackend {
        fn new(value: Option<&str>) -> Self {
            Self {
                value: Mutex::new(value.map(str::to_owned)),
                fail_store: AtomicBool::new(false),
                fail_clear: AtomicBool::new(false),
            }
        }
    }

    impl SecretBackend for TestSecretBackend {
        fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
            Ok(self
                .value
                .lock()
                .map_err(|_| "CREDENTIAL_LOAD_FAILED")?
                .clone()
                .map(Zeroizing::new))
        }

        fn store(&self, value: &str) -> Result<(), &'static str> {
            if self.fail_store.load(Ordering::Relaxed) {
                return Err("CREDENTIAL_STORE_FAILED");
            }
            *self.value.lock().map_err(|_| "CREDENTIAL_STORE_FAILED")? = Some(value.to_owned());
            Ok(())
        }

        fn clear(&self) -> Result<(), &'static str> {
            if self.fail_clear.load(Ordering::Relaxed) {
                return Err("CREDENTIAL_CLEAR_FAILED");
            }
            *self.value.lock().map_err(|_| "CREDENTIAL_CLEAR_FAILED")? = None;
            Ok(())
        }
    }

    fn session_value() -> &'static str {
        r#"{"schema":"jungle-bell.desktop-session","schemaVersion":1,"accessToken":"jbd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"2099-01-01T00:00:00Z"}"#
    }

    fn is_test_session(value: &str) -> bool {
        value == session_value()
    }

    #[test]
    fn legacy_session_is_migrated_only_after_keyring_write_succeeds() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(None));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend.clone()).unwrap();

        assert_eq!(
            store.load_validated(&is_test_session).unwrap().unwrap().as_str(),
            session_value()
        );
        assert_eq!(backend.load().unwrap().unwrap().as_str(), session_value());
        assert!(!directory.path().join(DESKTOP_SESSION_FILE).exists());
    }

    #[test]
    fn failed_keyring_migration_keeps_the_legacy_session_intact() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(None));
        backend.fail_store.store(true, Ordering::Relaxed);
        let store = KeyringCredentialStore::with_backend(directory.path(), backend).unwrap();

        assert_eq!(
            store.load_validated(&is_test_session).unwrap().unwrap().as_str(),
            session_value()
        );
        assert_eq!(legacy.load().unwrap().unwrap().as_str(), session_value());
        assert!(directory.path().join(DESKTOP_SESSION_FILE).exists());
    }

    #[test]
    fn an_existing_keyring_session_removes_a_stale_legacy_file() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(Some(session_value())));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend).unwrap();

        assert_eq!(
            store.load_validated(&is_test_session).unwrap().unwrap().as_str(),
            session_value()
        );
        assert!(!directory.path().join(DESKTOP_SESSION_FILE).exists());
    }

    #[test]
    fn keyring_load_keeps_the_legacy_fallback_until_full_validation_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(Some("{}")));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend).unwrap();

        assert_eq!(store.load().unwrap().unwrap().as_str(), "{}");
        assert_eq!(legacy.load().unwrap().unwrap().as_str(), session_value());
    }

    #[test]
    fn invalid_keyring_value_falls_back_to_a_fully_validated_legacy_session() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(Some("{}")));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend.clone()).unwrap();

        assert_eq!(
            store.load_validated(&is_test_session).unwrap().unwrap().as_str(),
            session_value()
        );
        assert_eq!(backend.load().unwrap().unwrap().as_str(), session_value());
        assert_eq!(legacy.load().unwrap(), None);
    }

    #[test]
    fn keyring_load_and_clear_remove_orphaned_legacy_temp_files() {
        let directory = tempfile::tempdir().unwrap();
        let backend = Arc::new(TestSecretBackend::new(Some(session_value())));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend).unwrap();
        let first_temp = directory.path().join(format!(
            "{DESKTOP_SESSION_TEMP_PREFIX}{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        write_private_temp(&first_temp, session_value()).unwrap();

        assert!(store.load().unwrap().is_some());
        assert!(!first_temp.exists());

        let second_temp = directory.path().join(format!(
            "{DESKTOP_SESSION_TEMP_PREFIX}{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        write_private_temp(&second_temp, session_value()).unwrap();
        store.clear().unwrap();
        assert!(!second_temp.exists());
    }

    #[cfg(unix)]
    #[test]
    fn orphan_cleanup_never_follows_a_matching_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("credential");
        fs::write(&target, session_value()).unwrap();
        let linked_temp = directory.path().join(format!(
            "{DESKTOP_SESSION_TEMP_PREFIX}{}.tmp",
            uuid::Uuid::new_v4().simple()
        ));
        symlink(&target, &linked_temp).unwrap();
        let backend = Arc::new(TestSecretBackend::new(Some(session_value())));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend).unwrap();

        assert_eq!(store.clear(), Err("CREDENTIAL_CLEAR_FAILED"));
        assert_eq!(fs::read_to_string(target).unwrap(), session_value());
        assert!(linked_temp.symlink_metadata().unwrap().file_type().is_symlink());
    }

    #[test]
    fn keyring_store_never_creates_a_plaintext_session_file_and_clear_removes_both_locations() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(None));
        let store = KeyringCredentialStore::with_backend(directory.path(), backend.clone()).unwrap();

        store.store(session_value()).unwrap();
        assert_eq!(backend.load().unwrap().unwrap().as_str(), session_value());
        assert!(!directory.path().join(DESKTOP_SESSION_FILE).exists());

        legacy.store(session_value()).unwrap();
        store.clear().unwrap();
        assert_eq!(backend.load().unwrap(), None);
        assert!(!directory.path().join(DESKTOP_SESSION_FILE).exists());
    }

    #[test]
    fn clear_attempts_legacy_removal_even_when_the_keyring_is_unavailable() {
        let directory = tempfile::tempdir().unwrap();
        let legacy = FileCredentialStore::new(directory.path()).unwrap();
        legacy.store(session_value()).unwrap();
        let backend = Arc::new(TestSecretBackend::new(Some(session_value())));
        backend.fail_clear.store(true, Ordering::Relaxed);
        let store = KeyringCredentialStore::with_backend(directory.path(), backend.clone()).unwrap();

        assert_eq!(store.clear(), Err("CREDENTIAL_CLEAR_FAILED"));
        assert!(backend.load().unwrap().is_some());
        assert!(!directory.path().join(DESKTOP_SESSION_FILE).exists());
    }

    #[test]
    fn legacy_desktop_app_session_is_private_and_clearable() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileCredentialStore::new(directory.path()).unwrap();
        let value = r#"{"schema":"jungle-bell.desktop-session","schemaVersion":1,"accessToken":"jbd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":"2099-01-01T00:00:00Z"}"#;

        assert!(store.is_persistent());
        assert_eq!(store.load().unwrap(), None);
        store.store(value).unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded.as_str(), value);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(directory.path().join(DESKTOP_SESSION_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }

        store.clear().unwrap();
        assert_eq!(store.load().unwrap(), None);
    }

    #[test]
    fn legacy_desktop_app_session_rejects_oversized_or_symlinked_storage() {
        let directory = tempfile::tempdir().unwrap();
        let store = FileCredentialStore::new(directory.path()).unwrap();
        assert_eq!(
            store.store(&"x".repeat(MAX_DESKTOP_SESSION_BYTES as usize + 1)),
            Err("CREDENTIAL_VALUE_INVALID")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let target = directory.path().join("outside-session");
            fs::write(&target, "do-not-touch").unwrap();
            symlink(&target, directory.path().join(DESKTOP_SESSION_FILE)).unwrap();
            assert_eq!(store.load(), Err("CREDENTIAL_FILE_INVALID"));
            assert_eq!(store.store("{}"), Err("CREDENTIAL_FILE_INVALID"));
            assert_eq!(fs::read_to_string(target).unwrap(), "do-not-touch");
        }
    }

    #[test]
    fn installation_id_is_stable_canonical_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let first = load_or_create_installation_identity(directory.path()).unwrap();
        let second = load_or_create_installation_identity(directory.path()).unwrap();
        assert!(first.newly_created);
        assert!(!second.newly_created);
        assert_eq!(first.id, second.id);
        assert_eq!(parse_installation_id(&first.id).unwrap(), first.id);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(directory.path().join(INSTALLATION_ID_FILE))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn malformed_or_symlinked_installation_id_is_never_silently_replaced() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(directory.path().join(INSTALLATION_ID_FILE), "../other-device").unwrap();
        assert_eq!(
            load_or_create_installation_identity(directory.path()),
            Err("INSTALLATION_ID_INVALID")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let second = tempfile::tempdir().unwrap();
            let target = second.path().join("target");
            fs::write(&target, uuid::Uuid::new_v4().hyphenated().to_string()).unwrap();
            symlink(&target, second.path().join(INSTALLATION_ID_FILE)).unwrap();
            assert_eq!(
                load_or_create_installation_identity(second.path()),
                Err("INSTALLATION_ID_INVALID")
            );
        }
    }

    #[test]
    fn old_installation_file_is_ignored_and_explicit_reset_rotates_identity() {
        let directory = tempfile::tempdir().unwrap();
        let old_id = uuid::Uuid::new_v4().hyphenated().to_string();
        fs::write(directory.path().join("connected-service-installation-id"), &old_id).unwrap();

        let first = load_or_create_installation_identity(directory.path()).unwrap();
        assert!(first.newly_created);
        assert_ne!(first.id, old_id);

        let reset = reset_installation_identity(directory.path()).unwrap();
        assert!(reset.newly_created);
        assert_ne!(reset.id, first.id);
    }
}
