use serde::{Deserialize, Serialize};
use specta::Type;

pub type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum AppError {
    #[error("{0}")]
    Io(String),
    #[error("{0}")]
    Database(String),
    #[error("{0}")]
    InvalidData(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Credentials(String),
    #[error("{0}")]
    Network(String),
    #[error("{0}")]
    Unauthorized(String),
    #[error("{0}")]
    RateLimited(String),
    #[error("{0}")]
    Unsupported(String),
    #[error("{0}")]
    Internal(String),
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::Io(error.to_string())
    }
}
impl From<rusqlite::Error> for AppError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error.to_string())
    }
}
impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::InvalidData(format!(
            "Invalid JSON at line {}, column {}",
            error.line(),
            error.column()
        ))
    }
}
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        Self::Internal("A native operation was interrupted. Restart Overwatch.".into())
    }
}
