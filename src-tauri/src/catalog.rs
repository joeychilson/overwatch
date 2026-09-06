use crate::{
    data::{CatalogPayload, CatalogRequest, CatalogSource},
    error::{AppError, Result},
    quota,
};
use std::path::Path;

pub async fn read(directory: &Path, request: CatalogRequest) -> Result<CatalogPayload> {
    let path = directory.join("catalog.json");
    if matches!(request, CatalogRequest::Bundled) {
        return Ok(bundled(None));
    }
    if matches!(request, CatalogRequest::Refresh) {
        let value = quota::response(quota::client()?.get("https://models.dev/api.json")).await?;
        if !value.as_object().is_some_and(|providers| {
            !providers.is_empty()
                && providers
                    .values()
                    .all(|provider| provider["name"].is_string() && provider["models"].is_object())
        }) {
            return Err(AppError::InvalidData(
                "models.dev returned an invalid provider catalog.".into(),
            ));
        }
        let payload = CatalogPayload {
            json: serde_json::to_string(&value)?,
            updated_at: chrono::Utc::now().timestamp_millis(),
            source: CatalogSource::Network,
            warning: None,
        };
        return Ok(payload);
    }
    let warning = match std::fs::read(&path) {
        Ok(bytes) => match serde_json::from_slice::<CatalogPayload>(&bytes) {
            Ok(mut payload) => {
                payload.source = CatalogSource::Cached;
                return Ok(payload);
            }
            Err(error) => Some(AppError::from(error)),
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => Some(AppError::from(error)),
    };
    Ok(bundled(warning))
}
fn bundled(warning: Option<AppError>) -> CatalogPayload {
    CatalogPayload {
        json: include_str!("../../public/catalog.json").into(),
        updated_at: 1_788_566_400_000,
        source: CatalogSource::Bundled,
        warning,
    }
}
// Called only after the frontend validates all consumed fields with Zod.
pub fn save(directory: &Path, payload: &CatalogPayload) -> Result<()> {
    let path = directory.join("catalog.json");
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(payload)?)?;
    std::fs::rename(temp, path)?;
    Ok(())
}
