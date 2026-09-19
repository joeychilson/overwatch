//! The picture of a period, written where its reader will find it.
//!
//! The window draws the card itself and sends the PNG over as base64, which is
//! what a canvas's data URL already carries. Nothing here interprets the image
//! beyond checking that it is one.

use std::fs::File;
use std::io::{ErrorKind, Write as _};
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

use crate::error::{Error, Result};

/// The extension every card is written under.
const EXTENSION: &str = "png";

/// The largest card accepted, decoded.
///
/// A card is a flat drawing about two thousand pixels across, which compresses
/// to well under a megabyte; this leaves room for a far busier one without
/// letting the window ask for an unbounded allocation.
const LARGEST: usize = 16 * 1024 * 1024;

/// The longest file name stem kept, before the extension and any number.
const LONGEST_NAME: usize = 96;

/// PNG's eight-byte signature, which every PNG opens with.
const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// The bytes of a base64 PNG.
///
/// # Errors
///
/// Returns [`Error::Invalid`] when the text is not base64, when it decodes to
/// more than [`LARGEST`] bytes, or when what it decodes to is not a PNG.
pub fn decode(png: &str) -> Result<Vec<u8>> {
    // Base64 is four characters to three bytes, so the encoded length bounds
    // the decoded one and an oversized card is refused before it is allocated.
    if png.len() / 4 * 3 > LARGEST {
        return Err(Error::Invalid("the card is too large to save".into()));
    }
    let bytes = STANDARD
        .decode(png)
        .map_err(|error| Error::Invalid(format!("the card could not be read: {error}")))?;
    if !bytes.starts_with(&SIGNATURE) {
        return Err(Error::Invalid("the card is not a PNG".into()));
    }
    Ok(bytes)
}

/// `name` reduced to lowercase words and hyphens, which every file system takes.
///
/// Anything else, a separator among it, becomes a hyphen, so a name from the
/// window can only ever name a file directly inside the folder it is given.
fn stem(name: &str) -> String {
    let mut reduced = String::with_capacity(LONGEST_NAME);
    for character in name.chars().take(LONGEST_NAME) {
        if character.is_ascii_alphanumeric() {
            reduced.push(character.to_ascii_lowercase());
        } else if !reduced.ends_with('-') {
            reduced.push('-');
        }
    }
    let trimmed = reduced.trim_matches('-');
    if trimmed.is_empty() {
        "overwatch".to_owned()
    } else {
        trimmed.to_owned()
    }
}

/// Write a card into `folder` under a name derived from `name`, and answer
/// with where it went.
///
/// It takes the first of `stem.png`, `stem-2.png`, and so on that is free.
/// Each is created only if it does not exist, so a card never displaces a
/// file, even one that appears while it is being saved.
///
/// # Errors
///
/// Returns [`Error::Write`] when the file cannot be created or written.
pub fn write(folder: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf> {
    let stem = stem(name);
    let mut number = 1_u32;
    loop {
        let path = folder.join(match number {
            1 => format!("{stem}.{EXTENSION}"),
            _ => format!("{stem}-{number}.{EXTENSION}"),
        });
        match File::create_new(&path).and_then(|mut file| file.write_all(bytes)) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == ErrorKind::AlreadyExists && number < u32::MAX => {
                number += 1;
            }
            Err(source) => {
                return Err(Error::Write {
                    path: path.display().to_string(),
                    source,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The smallest thing that passes for a PNG: the signature and nothing else.
    fn png() -> Vec<u8> {
        SIGNATURE.to_vec()
    }

    #[test]
    fn a_base64_png_decodes_to_its_bytes() {
        let encoded = STANDARD.encode(png());
        assert_eq!(decode(&encoded).expect("decodes"), png());
    }

    #[test]
    fn anything_that_is_not_a_png_is_refused() {
        let gif = STANDARD.encode(b"GIF89a and the rest");
        assert!(matches!(decode(&gif), Err(Error::Invalid(_))));
        assert!(matches!(
            decode("not base64 at all!!"),
            Err(Error::Invalid(_))
        ));
    }

    #[test]
    fn a_card_larger_than_the_limit_is_refused_before_it_is_decoded() {
        // A PNG's signature and a zero byte, then zeros past the limit: a PNG
        // by every other measure.
        let oversized = format!("iVBORw0KGgoA{}", "A".repeat(LARGEST / 3 * 4));
        assert!(matches!(
            decode(&oversized),
            Err(Error::Invalid(message)) if message.contains("too large")
        ));
    }

    #[test]
    fn a_name_can_only_ever_name_a_file_in_the_folder_it_is_given() {
        assert_eq!(
            stem("overwatch-7-days-2026-09-16"),
            "overwatch-7-days-2026-09-16"
        );
        assert_eq!(stem("../../etc/passwd"), "etc-passwd");
        assert_eq!(stem("/absolute/path"), "absolute-path");
        assert_eq!(stem("Last 30 Days!"), "last-30-days");
        assert_eq!(stem("   "), "overwatch");
        assert_eq!(stem(""), "overwatch");
        assert!(stem(&"x".repeat(500)).len() <= LONGEST_NAME);
    }

    #[test]
    fn saving_twice_keeps_both_cards() {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let first = write(folder.path(), "overwatch-7-days", &png()).expect("writes");
        let second = write(folder.path(), "overwatch-7-days", &png()).expect("writes");

        assert_eq!(first.file_name().expect("a name"), "overwatch-7-days.png");
        assert_eq!(
            second.file_name().expect("a name"),
            "overwatch-7-days-2.png"
        );
        assert_eq!(std::fs::read(&first).expect("reads"), png());
        assert_eq!(std::fs::read(&second).expect("reads"), png());
    }

    #[test]
    fn a_folder_that_is_not_there_is_reported_rather_than_panicked_over() {
        let folder = tempfile::tempdir().expect("a temporary folder");
        let missing = folder.path().join("no-such-folder");
        assert!(matches!(
            write(&missing, "overwatch", &png()),
            Err(Error::Write { path, .. }) if path.contains("no-such-folder")
        ));
    }
}
