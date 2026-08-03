use minisign_verify::{Error as MinisignError, PublicKey, Signature};
use std::env;
use std::ffi::OsString;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const ARTIFACT_BUFFER_BYTES: usize = 64 * 1024;
const MAX_PUBLIC_KEY_BYTES: usize = 4 * 1024;
const MAX_SIGNATURE_BYTES: usize = 16 * 1024;
const USAGE: &str =
    "usage: verify_updater_signature <public-key-file> <artifact-file> <signature-file>";

#[derive(Debug, PartialEq, Eq)]
struct InputPaths {
    public_key: PathBuf,
    artifact: PathBuf,
    signature: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CliError {
    Usage,
    PublicKeyUnavailable,
    PublicKeyNotRegular,
    PublicKeyTooLarge,
    PublicKeyInvalid,
    ArtifactUnavailable,
    ArtifactNotRegular,
    SignatureUnavailable,
    SignatureNotRegular,
    SignatureTooLarge,
    SignatureInvalid,
    SignatureKeyMismatch,
    PrehashedSignatureRequired,
    VerificationFailed,
}

impl CliError {
    const fn message(self) -> &'static str {
        match self {
            Self::Usage => USAGE,
            Self::PublicKeyUnavailable => "public key file could not be read",
            Self::PublicKeyNotRegular => "public key path is not a regular file",
            Self::PublicKeyTooLarge => "public key file exceeds the size limit",
            Self::PublicKeyInvalid => "public key file is not valid Minisign data",
            Self::ArtifactUnavailable => "artifact file could not be read",
            Self::ArtifactNotRegular => "artifact path is not a regular file",
            Self::SignatureUnavailable => "signature file could not be read",
            Self::SignatureNotRegular => "signature path is not a regular file",
            Self::SignatureTooLarge => "signature file exceeds the size limit",
            Self::SignatureInvalid => "signature file is not valid Minisign data",
            Self::SignatureKeyMismatch => "signature key does not match the public key",
            Self::PrehashedSignatureRequired => "signature must use Minisign prehashed mode",
            Self::VerificationFailed => "updater signature verification failed",
        }
    }

    const fn exit_code(self) -> u8 {
        match self {
            Self::Usage => 2,
            _ => 1,
        }
    }
}

fn parse_args<I>(args: I) -> Result<InputPaths, CliError>
where
    I: IntoIterator<Item = OsString>,
{
    let mut args = args.into_iter();
    args.next().ok_or(CliError::Usage)?;

    let public_key = args.next().filter(|arg| !arg.is_empty());
    let artifact = args.next().filter(|arg| !arg.is_empty());
    let signature = args.next().filter(|arg| !arg.is_empty());

    match (public_key, artifact, signature, args.next()) {
        (Some(public_key), Some(artifact), Some(signature), None) => Ok(InputPaths {
            public_key: public_key.into(),
            artifact: artifact.into(),
            signature: signature.into(),
        }),
        _ => Err(CliError::Usage),
    }
}

fn open_regular_file(
    path: &Path,
    unavailable: CliError,
    not_regular: CliError,
) -> Result<File, CliError> {
    let file = File::open(path).map_err(|_| unavailable)?;
    let metadata = file.metadata().map_err(|_| unavailable)?;
    if !metadata.is_file() {
        return Err(not_regular);
    }

    Ok(file)
}

fn read_bounded_text(
    mut file: File,
    maximum_bytes: usize,
    unavailable: CliError,
    too_large: CliError,
    invalid: CliError,
) -> Result<String, CliError> {
    let metadata = file.metadata().map_err(|_| unavailable)?;
    if metadata.len() > maximum_bytes as u64 {
        return Err(too_large);
    }

    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.by_ref()
        .take(maximum_bytes as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable)?;
    if bytes.len() > maximum_bytes {
        return Err(too_large);
    }

    String::from_utf8(bytes).map_err(|_| invalid)
}

fn parse_public_key(text: &str) -> Result<PublicKey, CliError> {
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 2 || !lines[0].starts_with("untrusted comment:") {
        return Err(CliError::PublicKeyInvalid);
    }

    PublicKey::decode(text).map_err(|_| CliError::PublicKeyInvalid)
}

fn parse_signature(text: &str) -> Result<Signature, CliError> {
    let lines: Vec<_> = text.lines().collect();
    if lines.len() != 4
        || !lines[0].starts_with("untrusted comment:")
        || !lines[2].starts_with("trusted comment: ")
    {
        return Err(CliError::SignatureInvalid);
    }

    Signature::decode(text).map_err(|_| CliError::SignatureInvalid)
}

fn stream_verifier_error(error: MinisignError) -> CliError {
    match error {
        MinisignError::UnexpectedKeyId => CliError::SignatureKeyMismatch,
        MinisignError::UnsupportedLegacyMode => CliError::PrehashedSignatureRequired,
        _ => CliError::SignatureInvalid,
    }
}

fn verify_files(paths: &InputPaths) -> Result<(), CliError> {
    let public_key_file = open_regular_file(
        &paths.public_key,
        CliError::PublicKeyUnavailable,
        CliError::PublicKeyNotRegular,
    )?;
    let public_key_text = read_bounded_text(
        public_key_file,
        MAX_PUBLIC_KEY_BYTES,
        CliError::PublicKeyUnavailable,
        CliError::PublicKeyTooLarge,
        CliError::PublicKeyInvalid,
    )?;
    let public_key = parse_public_key(&public_key_text)?;

    let signature_file = open_regular_file(
        &paths.signature,
        CliError::SignatureUnavailable,
        CliError::SignatureNotRegular,
    )?;
    let signature_text = read_bounded_text(
        signature_file,
        MAX_SIGNATURE_BYTES,
        CliError::SignatureUnavailable,
        CliError::SignatureTooLarge,
        CliError::SignatureInvalid,
    )?;
    let signature = parse_signature(&signature_text)?;
    let mut verifier = public_key
        .verify_stream(&signature)
        .map_err(stream_verifier_error)?;

    let mut artifact = open_regular_file(
        &paths.artifact,
        CliError::ArtifactUnavailable,
        CliError::ArtifactNotRegular,
    )?;
    let mut buffer = [0_u8; ARTIFACT_BUFFER_BYTES];
    loop {
        let bytes_read = artifact
            .read(&mut buffer)
            .map_err(|_| CliError::ArtifactUnavailable)?;
        if bytes_read == 0 {
            break;
        }
        verifier.update(&buffer[..bytes_read]);
    }

    verifier
        .finalize()
        .map_err(|_| CliError::VerificationFailed)
}

fn run<I>(args: I) -> Result<(), CliError>
where
    I: IntoIterator<Item = OsString>,
{
    let paths = parse_args(args)?;
    verify_files(&paths)
}

fn main() -> ExitCode {
    match run(env::args_os()) {
        Ok(()) => {
            println!("updater signature verified");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("error: {}", error.message());
            ExitCode::from(error.exit_code())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    const PUBLIC_KEY: &str = "untrusted comment: updater verification test key\n\
RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
    const PREHASHED_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\n\
RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n\
trusted comment: timestamp:1556193335\tfile:test\n\
y/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==\n";
    const LEGACY_SIGNATURE: &str = "untrusted comment: signature from minisign secret key\n\
RWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\n\
trusted comment: timestamp:1555779966\tfile:test\n\
QtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==\n";

    struct Fixture {
        _directory: TempDir,
        paths: InputPaths,
    }

    fn fixture(artifact: &[u8], signature: &str) -> Fixture {
        let directory = tempfile::tempdir().expect("temporary directory should be created");
        let public_key = directory.path().join("updater.pub");
        let artifact_path = directory.path().join("update.tar.gz");
        let signature_path = directory.path().join("update.tar.gz.sig");

        fs::write(&public_key, PUBLIC_KEY).expect("public key fixture should be written");
        fs::write(&artifact_path, artifact).expect("artifact fixture should be written");
        fs::write(&signature_path, signature).expect("signature fixture should be written");

        Fixture {
            _directory: directory,
            paths: InputPaths {
                public_key,
                artifact: artifact_path,
                signature: signature_path,
            },
        }
    }

    #[test]
    fn accepts_exactly_three_non_empty_file_arguments() {
        let paths = parse_args([
            OsString::from("verifier"),
            OsString::from("updater.pub"),
            OsString::from("update.tar.gz"),
            OsString::from("update.tar.gz.sig"),
        ])
        .expect("three paths should be accepted");

        assert_eq!(paths.public_key, PathBuf::from("updater.pub"));
        assert_eq!(paths.artifact, PathBuf::from("update.tar.gz"));
        assert_eq!(paths.signature, PathBuf::from("update.tar.gz.sig"));
    }

    #[test]
    fn rejects_missing_extra_or_empty_arguments() {
        for args in [
            vec![OsString::from("verifier")],
            vec![
                OsString::from("verifier"),
                OsString::from("key"),
                OsString::from("artifact"),
            ],
            vec![
                OsString::from("verifier"),
                OsString::from("key"),
                OsString::from("artifact"),
                OsString::from("signature"),
                OsString::from("extra"),
            ],
            vec![
                OsString::from("verifier"),
                OsString::new(),
                OsString::from("artifact"),
                OsString::from("signature"),
            ],
        ] {
            assert_eq!(parse_args(args), Err(CliError::Usage));
        }
    }

    #[test]
    fn verifies_a_prehashed_signature_while_streaming_the_artifact() {
        let fixture = fixture(b"test", PREHASHED_SIGNATURE);

        assert_eq!(verify_files(&fixture.paths), Ok(()));
    }

    #[test]
    fn rejects_a_tampered_artifact() {
        let fixture = fixture(b"tampered", PREHASHED_SIGNATURE);

        assert_eq!(
            verify_files(&fixture.paths),
            Err(CliError::VerificationFailed)
        );
    }

    #[test]
    fn rejects_legacy_non_prehashed_signatures() {
        let fixture = fixture(b"test", LEGACY_SIGNATURE);

        assert_eq!(
            verify_files(&fixture.paths),
            Err(CliError::PrehashedSignatureRequired)
        );
    }
}
