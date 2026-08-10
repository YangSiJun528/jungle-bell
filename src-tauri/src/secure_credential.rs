//! 설치 식별자와 앱 bearer를 위한 로컬 저장소 경계.
//!
//! 설치 식별자는 비밀이 아니며 앱 데이터 디렉터리에 0600 파일로 저장한다.
//! bearer는 사용자 승인 창을 띄우는 OS keyring이나 평문 파일에 저장하지 않고
//! 프로세스 메모리에만 유지한다.

use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::Path,
};

use zeroize::Zeroizing;

const INSTALLATION_ID_FILE: &str = "connected-service-installation-id";
const MAX_INSTALLATION_ID_BYTES: u64 = 64;
pub(crate) trait CredentialStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str>;
    fn store(&self, value: &str) -> Result<(), &'static str>;
    fn clear(&self) -> Result<(), &'static str>;
    fn is_persistent(&self) -> bool {
        true
    }
}

/// OS keyring을 사용할 수 없는 환경의 안전한 fallback. 프로세스 메모리 외에는
/// credential을 남기지 않으므로 평문 파일 fallback보다 기능은 제한되지만 안전하다.
pub(crate) struct VolatileCredentialStore;

impl VolatileCredentialStore {
    pub(crate) fn new() -> Self {
        Self
    }
}

impl CredentialStore for VolatileCredentialStore {
    fn load(&self) -> Result<Option<Zeroizing<String>>, &'static str> {
        Ok(None)
    }

    fn store(&self, _value: &str) -> Result<(), &'static str> {
        // RemoteSyncService가 프로세스 수명 동안 Zeroizing bearer를 보유한다.
        // fallback store에는 두 번째 평문 사본을 만들지 않는다.
        Err("CREDENTIAL_STORE_VOLATILE")
    }

    fn clear(&self) -> Result<(), &'static str> {
        Ok(())
    }

    fn is_persistent(&self) -> bool {
        false
    }
}

pub(crate) fn load_or_create_installation_id(app_data_dir: &Path) -> Result<String, &'static str> {
    fs::create_dir_all(app_data_dir).map_err(|_| "INSTALLATION_STORAGE_FAILED")?;
    let path = app_data_dir.join(INSTALLATION_ID_FILE);
    match read_installation_id(&path) {
        Ok(value) => return Ok(value),
        Err(InstallationReadError::Missing) => {}
        Err(InstallationReadError::Invalid) => return Err("INSTALLATION_ID_INVALID"),
        Err(InstallationReadError::Storage) => return Err("INSTALLATION_STORAGE_FAILED"),
    }

    let generated = uuid::Uuid::new_v4().hyphenated().to_string();
    match create_installation_id(&path, &generated) {
        Ok(()) => Ok(generated),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => {
            read_installation_id(&path).map_err(|error| match error {
                InstallationReadError::Invalid => "INSTALLATION_ID_INVALID",
                InstallationReadError::Missing | InstallationReadError::Storage => "INSTALLATION_STORAGE_FAILED",
            })
        }
        Err(_) => Err("INSTALLATION_STORAGE_FAILED"),
    }
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
    if !metadata.file_type().is_file() || metadata.len() > MAX_INSTALLATION_ID_BYTES {
        return Err(InstallationReadError::Invalid);
    }
    let value = fs::read_to_string(path).map_err(|_| InstallationReadError::Storage)?;
    parse_installation_id(&value).map_err(|_| InstallationReadError::Invalid)
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
    fn server_credentials_are_memory_only() {
        let store = VolatileCredentialStore::new();
        assert!(!store.is_persistent());
        assert_eq!(store.load().unwrap(), None);
        assert_eq!(store.store("secret"), Err("CREDENTIAL_STORE_VOLATILE"));
        assert_eq!(store.clear(), Ok(()));
    }

    #[test]
    fn installation_id_is_stable_canonical_and_private() {
        let directory = tempfile::tempdir().unwrap();
        let first = load_or_create_installation_id(directory.path()).unwrap();
        let second = load_or_create_installation_id(directory.path()).unwrap();
        assert_eq!(first, second);
        assert_eq!(parse_installation_id(&first).unwrap(), first);

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
            load_or_create_installation_id(directory.path()),
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
                load_or_create_installation_id(second.path()),
                Err("INSTALLATION_ID_INVALID")
            );
        }
    }
}
