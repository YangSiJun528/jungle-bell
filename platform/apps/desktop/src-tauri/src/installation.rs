use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};

#[cfg(unix)]
use std::fs::File;

use sha2::{Digest, Sha256};
use uuid::Uuid;

const INSTALLATION_ID_FILE: &str = "installation-id";
const SUBJECT_BINDING_FILE: &str = "lms-subject-binding";
const SUBJECT_BINDING_TEMP_PREFIX: &str = ".lms-subject-binding.";
const SUBJECT_BINDING_TEMP_SUFFIX: &str = ".tmp";
const MAX_INSTALLATION_ID_FILE_BYTES: u64 = 64;
const SUBJECT_BINDING_BYTES: u64 = 64;

pub(crate) fn load_or_create_installation_id(app_data_dir: &Path) -> Result<String, String> {
    fs::create_dir_all(app_data_dir).map_err(|_| "INSTALLATION_ID_STORAGE_FAILED".to_owned())?;
    let path = app_data_dir.join(INSTALLATION_ID_FILE);
    match read_installation_id(&path) {
        Ok(value) => return Ok(value),
        Err(InstallationReadError::Missing) => {}
        Err(InstallationReadError::Invalid) => {
            return Err("INSTALLATION_ID_INVALID".into());
        }
        Err(InstallationReadError::Storage) => {
            return Err("INSTALLATION_ID_STORAGE_FAILED".into());
        }
    }

    let generated = Uuid::new_v4().hyphenated().to_string();
    match create_installation_id(&path, &generated) {
        Ok(()) => Ok(generated),
        Err(error) if error.kind() == ErrorKind::AlreadyExists => read_installation_id(&path)
            .map_err(|error| match error {
                InstallationReadError::Invalid => "INSTALLATION_ID_INVALID".to_owned(),
                InstallationReadError::Missing | InstallationReadError::Storage => {
                    "INSTALLATION_ID_STORAGE_FAILED".to_owned()
                }
            }),
        Err(_) => Err("INSTALLATION_ID_STORAGE_FAILED".into()),
    }
}

pub(crate) fn parse_installation_id(value: &str) -> Result<String, String> {
    let parsed = Uuid::parse_str(value).map_err(|_| "INSTALLATION_ID_INVALID".to_owned())?;
    let canonical = parsed.hyphenated().to_string();
    if value == canonical {
        Ok(canonical)
    } else {
        Err("INSTALLATION_ID_INVALID".into())
    }
}

pub(crate) fn subject_binding_digest(
    installation_id: &str,
    subject: &str,
) -> Result<String, String> {
    let installation_id = parse_installation_id(installation_id)?;
    if subject.is_empty()
        || subject.len() > 128
        || subject.trim() != subject
        || subject.chars().any(char::is_control)
    {
        return Err("LMS_SUBJECT_BINDING_INVALID".into());
    }
    let mut digest = Sha256::new();
    digest.update(b"jungle-bell:lms-subject-binding:v1\0");
    digest.update(installation_id.as_bytes());
    digest.update(b"\0");
    digest.update(subject.as_bytes());
    Ok(format!("{:x}", digest.finalize()))
}

pub(crate) fn load_subject_binding(app_data_dir: &Path) -> Result<Option<String>, String> {
    let path = app_data_dir.join(SUBJECT_BINDING_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("LMS_SUBJECT_BINDING_STORAGE_FAILED".into()),
    };
    if !metadata.file_type().is_file() || metadata.len() != SUBJECT_BINDING_BYTES {
        discard_invalid_subject_binding(app_data_dir, &path, &metadata);
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|_| "LMS_SUBJECT_BINDING_STORAGE_FAILED".to_owned())?;
    let value = std::str::from_utf8(&bytes).ok();
    if value.is_some_and(is_subject_binding_digest) {
        return Ok(value.map(str::to_owned));
    }
    discard_invalid_subject_binding(app_data_dir, &path, &metadata);
    Ok(None)
}

pub(crate) fn store_subject_binding(app_data_dir: &Path, value: &str) -> Result<(), String> {
    if !is_subject_binding_digest(value) {
        return Err("LMS_SUBJECT_BINDING_INVALID".into());
    }
    fs::create_dir_all(app_data_dir)
        .map_err(|_| "LMS_SUBJECT_BINDING_STORAGE_FAILED".to_owned())?;
    let path = app_data_dir.join(SUBJECT_BINDING_FILE);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| !metadata.file_type().is_file()) {
        return Err("LMS_SUBJECT_BINDING_INVALID".into());
    }
    store_subject_binding_atomic(app_data_dir, &path, value, |_| Ok(()))
}

fn store_subject_binding_atomic<F>(
    app_data_dir: &Path,
    path: &Path,
    value: &str,
    before_rename: F,
) -> Result<(), String>
where
    F: FnOnce(&Path) -> std::io::Result<()>,
{
    let temporary = subject_binding_temp_path(app_data_dir);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let result = (|| {
        let mut file = options.open(&temporary)?;
        file.write_all(value.as_bytes())?;
        file.sync_all()?;
        drop(file);
        before_rename(&temporary)?;
        fs::rename(&temporary, path)?;
        sync_directory(app_data_dir)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|_| "LMS_SUBJECT_BINDING_STORAGE_FAILED".to_owned())
}

pub(crate) fn delete_subject_binding(app_data_dir: &Path) -> Result<(), String> {
    let path = app_data_dir.join(SUBJECT_BINDING_FILE);
    match fs::remove_file(path) {
        Ok(()) => sync_directory(app_data_dir)
            .map_err(|_| "LMS_SUBJECT_BINDING_STORAGE_FAILED".to_owned()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(_) => Err("LMS_SUBJECT_BINDING_STORAGE_FAILED".into()),
    }
}

fn subject_binding_temp_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(format!(
        "{SUBJECT_BINDING_TEMP_PREFIX}{}{SUBJECT_BINDING_TEMP_SUFFIX}",
        Uuid::new_v4().hyphenated()
    ))
}

fn discard_invalid_subject_binding(app_data_dir: &Path, path: &Path, metadata: &fs::Metadata) {
    let removed = if metadata.file_type().is_dir() {
        fs::remove_dir(path)
    } else {
        fs::remove_file(path)
    };
    if removed.is_ok() {
        let _ = sync_directory(app_data_dir);
    }
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

// Windows has no supported directory fsync equivalent. The temporary file is
// still flushed before the same-directory atomic rename.
#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

fn is_subject_binding_digest(value: &str) -> bool {
    value.len() == SUBJECT_BINDING_BYTES as usize
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
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
    if !metadata.file_type().is_file() || metadata.len() > MAX_INSTALLATION_ID_FILE_BYTES {
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
mod tests {
    use super::{
        delete_subject_binding, load_or_create_installation_id, load_subject_binding,
        parse_installation_id, store_subject_binding, store_subject_binding_atomic,
        subject_binding_digest, SUBJECT_BINDING_FILE, SUBJECT_BINDING_TEMP_PREFIX,
        SUBJECT_BINDING_TEMP_SUFFIX,
    };

    #[test]
    fn installation_id_is_stable_and_only_one_file_is_created() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let first = load_or_create_installation_id(directory.path()).expect("first ID");
        let second = load_or_create_installation_id(directory.path()).expect("stable ID");

        assert_eq!(first, second);
        assert_eq!(
            std::fs::read_dir(directory.path())
                .expect("directory")
                .count(),
            1
        );
    }

    #[test]
    fn rejects_non_uuid_or_non_canonical_installation_ids() {
        for value in [
            "",
            "desktop-1",
            "550E8400-E29B-41D4-A716-446655440000",
            "550e8400-e29b-41d4-a716-446655440000\n",
            "../550e8400-e29b-41d4-a716-446655440000",
        ] {
            assert!(parse_installation_id(value).is_err(), "{value:?}");
        }
        assert_eq!(
            parse_installation_id("550e8400-e29b-41d4-a716-446655440000").expect("canonical UUID"),
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }

    #[test]
    fn persists_only_a_domain_separated_subject_digest() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let installation_id =
            load_or_create_installation_id(directory.path()).expect("installation ID");
        let first =
            subject_binding_digest(&installation_id, "lms-user-42").expect("subject digest");
        let second = subject_binding_digest(&installation_id, "lms-user-43")
            .expect("different subject digest");

        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
        assert!(!first.contains("lms-user"));
        store_subject_binding(directory.path(), &first).expect("store binding");
        assert_eq!(
            load_subject_binding(directory.path()).expect("load binding"),
            Some(first)
        );
        delete_subject_binding(directory.path()).expect("delete binding");
        assert_eq!(
            load_subject_binding(directory.path()).expect("binding removed"),
            None
        );
    }

    #[test]
    fn subject_binding_matches_the_cross_runtime_protocol_vector() {
        assert_eq!(
            subject_binding_digest("550e8400-e29b-41d4-a716-446655440000", "lms-user-42")
                .expect("subject digest"),
            "32bb7cb9cdb6aaee5104ac2626e27d402f5825e9b3e7283bd33dfcd1bcae3424"
        );
    }

    #[test]
    fn atomically_replaces_the_binding_with_private_permissions() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let installation_id =
            load_or_create_installation_id(directory.path()).expect("installation ID");
        let first = subject_binding_digest(&installation_id, "lms-user-42").expect("first digest");
        let second =
            subject_binding_digest(&installation_id, "lms-user-43").expect("second digest");

        store_subject_binding(directory.path(), &first).expect("first binding");
        store_subject_binding(directory.path(), &second).expect("replacement binding");
        assert_eq!(
            load_subject_binding(directory.path()).expect("load binding"),
            Some(second)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mode = std::fs::metadata(directory.path().join(SUBJECT_BINDING_FILE))
                .expect("binding metadata")
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn interrupted_atomic_replacement_keeps_the_previous_binding() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let installation_id =
            load_or_create_installation_id(directory.path()).expect("installation ID");
        let first = subject_binding_digest(&installation_id, "lms-user-42").expect("first digest");
        let second =
            subject_binding_digest(&installation_id, "lms-user-43").expect("second digest");
        store_subject_binding(directory.path(), &first).expect("first binding");

        let path = directory.path().join(SUBJECT_BINDING_FILE);
        let result = store_subject_binding_atomic(directory.path(), &path, &second, |temporary| {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;

                let mode = std::fs::metadata(temporary)?.permissions().mode() & 0o777;
                assert_eq!(mode, 0o600);
            }
            Err(std::io::Error::other("simulated crash before rename"))
        });

        assert_eq!(result, Err("LMS_SUBJECT_BINDING_STORAGE_FAILED".to_owned()));
        assert_eq!(
            load_subject_binding(directory.path()).expect("load old binding"),
            Some(first)
        );
    }

    #[test]
    fn stale_crash_temp_is_ignored_and_never_promoted() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let stale = directory.path().join(format!(
            "{SUBJECT_BINDING_TEMP_PREFIX}{}{SUBJECT_BINDING_TEMP_SUFFIX}",
            uuid::Uuid::new_v4().hyphenated()
        ));
        std::fs::write(&stale, b"partially-written-digest").expect("stale crash temp");

        assert_eq!(
            load_subject_binding(directory.path()).expect("missing binding"),
            None
        );
        assert!(
            stale.exists(),
            "uncommitted temp must not become authoritative"
        );
    }

    #[test]
    fn truncated_or_malformed_binding_recovers_as_unregistered() {
        let directory = tempfile::tempdir().expect("temporary app data");
        let path = directory.path().join(SUBJECT_BINDING_FILE);
        for malformed in [
            b"truncated".as_slice(),
            b"GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG".as_slice(),
            &[0xff; 64],
        ] {
            std::fs::write(&path, malformed).expect("corrupt binding");
            assert_eq!(
                load_subject_binding(directory.path()).expect("safe corruption recovery"),
                None
            );
            assert!(!path.exists(), "corrupt authoritative binding is deleted");
        }
    }

    #[cfg(unix)]
    #[test]
    fn binding_symlink_is_deleted_without_touching_its_target() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("temporary app data");
        let target = directory.path().join("outside-binding");
        let path = directory.path().join(SUBJECT_BINDING_FILE);
        std::fs::write(&target, "a".repeat(64)).expect("symlink target");
        symlink(&target, &path).expect("binding symlink");

        assert_eq!(
            load_subject_binding(directory.path()).expect("safe symlink recovery"),
            None
        );
        assert!(!path.exists());
        assert_eq!(
            std::fs::read_to_string(target).expect("untouched target"),
            "a".repeat(64)
        );
    }
}
