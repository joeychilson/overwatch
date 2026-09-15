//! Failures a command can report.
//!
//! One small enum. A command either returns its payload or one of these, and
//! the frontend shows `message`. A source file that cannot be read is not an
//! error here — indexing records it as a problem in [`crate::session::Status`]
//! and carries on with every other source.

use serde::Serialize;

/// What went wrong.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// The requested session, file, or transcript does not exist.
    #[error("{0} was not found")]
    NotFound(String),

    /// A file could not be read.
    #[error("could not read {path}: {source}")]
    Read {
        /// The file concerned.
        path: String,
        /// The underlying failure.
        source: std::io::Error,
    },

    /// The index database failed.
    #[error("the index database failed: {0}")]
    Store(#[from] rusqlite::Error),

    /// The system could not open a file or folder.
    #[error("could not open it: {0}")]
    Open(String),
}

/// The shape a failure takes on the wire.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    /// A stable discriminator, for callers that branch on the kind.
    kind: &'static str,
    /// Text safe to display: never a transcript body or a credential.
    message: String,
}

impl Error {
    /// A stable name for the kind of failure.
    fn kind(&self) -> &'static str {
        match self {
            Error::NotFound(_) => "not_found",
            Error::Read { .. } => "read_failed",
            Error::Store(_) => "store_failed",
            Error::Open(_) => "open_failed",
        }
    }
}

impl Serialize for Error {
    fn serialize<S: serde::Serializer>(
        &self,
        serializer: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        Wire {
            kind: self.kind(),
            message: self.to_string(),
        }
        .serialize(serializer)
    }
}

/// The result of anything that can fail.
pub type Result<T> = std::result::Result<T, Error>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failures_serialize_with_a_kind_and_a_message() {
        let error = Error::NotFound("session abc".into());
        let json = serde_json::to_value(&error).expect("serializes");
        assert_eq!(json["kind"], "not_found");
        assert_eq!(json["message"], "session abc was not found");
    }

    #[test]
    fn read_failures_name_the_file() {
        let error = Error::Read {
            path: "/tmp/history.jsonl".into(),
            source: std::io::Error::from(std::io::ErrorKind::PermissionDenied),
        };
        let json = serde_json::to_value(&error).expect("serializes");
        assert_eq!(json["kind"], "read_failed");
        assert!(
            json["message"]
                .as_str()
                .expect("message is text")
                .contains("/tmp/history.jsonl")
        );
    }
}
