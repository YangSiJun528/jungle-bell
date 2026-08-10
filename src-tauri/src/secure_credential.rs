//! 설치 식별자와 Jungle Bell 데스크톱 세션을 위한 로컬 저장소 경계.
//!
//! LMS cookie/token은 이 모듈에 전달하거나 저장하지 않는다. 서버가 발급한
//! 불투명한 Jungle Bell 세션만 앱 전용 데이터 디렉터리의 일반 파일에 저장한다.
//! Unix에서는 mode 0600을 강제하고, Windows에서는 앱 데이터 디렉터리의 상속
//! ACL에 의존한다. 두 플랫폼 모두 파일 종류·크기·symlink 경계를 검증한다.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

use zeroize::Zeroizing;

const INSTALLATION_ID_FILE: &str = "desktop-installation-id-v1";
const MAX_INSTALLATION_ID_BYTES: u64 = 64;
const DESKTOP_SESSION_FILE: &str = "desktop-app-session-v1";
const DESKTOP_SESSION_TEMP_PREFIX: &str = ".desktop-app-session-v1.";
const MAX_DESKTOP_SESSION_BYTES: u64 = 512;

pub(crate) trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str>;
    fn store(&self, value: &str) -> Result<(), &'static str>;
    fn clear(&self) -> Result<(), &'static str>;
    fn is_persistent(&self) -> bool {
        true
    }
}

pub(crate) struct FileCredentialStore {
    directory: PathBuf,
    path: PathBuf,
}

impl FileCredentialStore {
    pub(crate) fn new(app_data_dir: &Path) -> Result<Self, &'static str> {
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

    #[test]
    fn desktop_app_session_is_persistent_private_and_clearable() {
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
    fn desktop_app_session_rejects_oversized_or_symlinked_storage() {
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
