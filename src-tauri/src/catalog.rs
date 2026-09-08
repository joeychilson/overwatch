use crate::{
    data::{CatalogPayload, CatalogRequest, CatalogSource},
    error::{AppError, Result},
    index::Index,
    quota, settings,
};

#[path = "catalog_projection.rs"]
mod projection;

pub async fn read(index: &Index, request: CatalogRequest) -> Result<CatalogPayload> {
    let compact = matches!(
        request,
        CatalogRequest::Compact | CatalogRequest::CompactBundled
    );
    if matches!(
        request,
        CatalogRequest::Bundled | CatalogRequest::CompactBundled
    ) {
        return Ok(bundled(compact, None));
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
        return Ok(CatalogPayload {
            json: serde_json::to_string(&value)?,
            updated_at: chrono::Utc::now().timestamp_millis(),
            source: CatalogSource::Network,
            warning: None,
        });
    }
    Ok(stored(index, compact))
}

pub(crate) fn stored(index: &Index, compact: bool) -> CatalogPayload {
    let result = (|| -> Result<Option<CatalogPayload>> {
        let key = if compact {
            "catalog/pricing"
        } else {
            "catalog/full"
        };
        let cached = settings::read::<CatalogPayload>(&*index.db.lock()?, key)?;
        if let Some(payload) = cached {
            // Validate the embedded catalog, not just its envelope. Native usage
            // queries and the frontend must use the same offline fallback if the
            // stored prices are damaged.
            projection::pricing(&serde_json::from_str(&payload.json)?)
                .map_err(|error| AppError::InvalidData(error.into()))?;
            return Ok(Some(payload));
        }
        // Migrate the old file once. Future starts read only the compact SQLite value.
        match std::fs::read(index.directory.join("catalog.json")) {
            Ok(bytes) => {
                let payload: CatalogPayload = serde_json::from_slice(&bytes)?;
                save(index, &payload)?;
                settings::read(&*index.db.lock()?, key)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    })();
    match result {
        Ok(Some(mut payload)) => {
            payload.source = CatalogSource::Cached;
            payload
        }
        Ok(None) => bundled(compact, None),
        Err(error) => bundled(compact, Some(error)),
    }
}

fn bundled(compact: bool, warning: Option<AppError>) -> CatalogPayload {
    CatalogPayload {
        json: if compact {
            include_str!(concat!(env!("OUT_DIR"), "/pricing.json"))
        } else {
            include_str!("../../public/catalog.json")
        }
        .into(),
        updated_at: 1_788_566_400_000,
        source: CatalogSource::Bundled,
        warning,
    }
}

// Called after full frontend validation. Both views are replaced in one transaction.
pub fn save(index: &Index, payload: &CatalogPayload) -> Result<()> {
    let value = serde_json::from_str(&payload.json)?;
    let compact =
        projection::pricing(&value).map_err(|error| AppError::InvalidData(error.into()))?;
    let pricing = CatalogPayload {
        json: serde_json::to_string(&compact)?,
        ..payload.clone()
    };
    let mut db = index.db.lock()?;
    let tx = db.transaction()?;
    settings::write(&tx, "catalog/full", payload)?;
    settings::write(&tx, "catalog/pricing", &pricing)?;
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::default_sources;
    use serde_json::json;

    #[test]
    fn bundled_projection_preserves_every_identity_and_consumed_price() -> Result<()> {
        let full = bundled(false, None);
        let compact = bundled(true, None);
        let value = serde_json::from_str(&full.json)?;
        assert_eq!(
            projection::pricing(&value).unwrap(),
            serde_json::from_str::<serde_json::Value>(&compact.json)?
        );
        assert!(compact.json.len() < full.json.len() / 2);
        assert_eq!(compact.updated_at, full.updated_at);
        Ok(())
    }

    #[test]
    fn refresh_is_atomic_and_invalid_prices_preserve_last_good_revision() -> Result<()> {
        let root = tempfile::tempdir()?;
        let index = Index::open(root.path().into(), default_sources()?)?;
        let payload = CatalogPayload {
            json: json!({"lab":{"name":"Lab","models":{"exact/v1":{"id":"exact/v1","name":"Model","cost":{"input":0,"output":2},"description":"Long description"}}}}).to_string(),
            updated_at: 123, source: CatalogSource::Network, warning: None,
        };
        save(&index, &payload)?;
        let compact = stored(&index, true);
        assert!(!compact.json.contains("description"));
        assert_eq!(compact.updated_at, 123);
        assert!(compact.json.contains("\"input\":0"));
        assert!(!compact.json.contains("cache_read"));
        let mut bad = payload.clone();
        bad.json = bad.json.replace("\"input\":0", "\"input\":-1");
        assert!(save(&index, &bad).is_err());
        assert_eq!(stored(&index, false).json, payload.json);
        assert_eq!(stored(&index, true).json, compact.json);
        index.db.lock()?.execute_batch("CREATE TRIGGER fail_catalog BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'fixture'); END; CREATE TRIGGER fail_catalog_insert BEFORE INSERT ON settings WHEN NEW.key='catalog/pricing' BEGIN SELECT RAISE(ABORT,'fixture'); END;")?;
        let mut next = payload.clone();
        next.updated_at = 456;
        assert!(save(&index, &next).is_err());
        assert_eq!(stored(&index, false).updated_at, 123);
        Ok(())
    }

    #[test]
    fn legacy_cache_migrates_once_and_corrupt_cache_falls_back() -> Result<()> {
        let root = tempfile::tempdir()?;
        let index = Index::open(root.path().into(), default_sources()?)?;
        let payload = bundled(false, None);
        std::fs::write(
            root.path().join("catalog.json"),
            serde_json::to_vec(&payload)?,
        )?;
        assert!(matches!(stored(&index, true).source, CatalogSource::Cached));
        std::fs::write(root.path().join("catalog.json"), "invalid")?;
        assert!(stored(&index, true).warning.is_none());
        index.db.lock()?.execute(
            "UPDATE settings SET data='invalid' WHERE key='catalog/pricing'",
            [],
        )?;
        let fallback = stored(&index, true);
        assert!(matches!(fallback.source, CatalogSource::Bundled));
        assert!(fallback.warning.is_some());
        for json in [
            "invalid".to_string(),
            json!({"lab":{"name":"Lab","models":{"broken":{"id":"broken","name":"Broken","cost":{"input":-1}}}}}).to_string(),
        ] {
            let damaged = CatalogPayload { json, ..payload.clone() };
            settings::write(&*index.db.lock()?, "catalog/pricing", &damaged)?;
            let fallback = stored(&index, true);
            assert!(matches!(fallback.source, CatalogSource::Bundled));
            assert!(fallback.warning.is_some());
            assert_eq!(fallback.json, bundled(true, None).json);
            assert!(crate::queries::usage(&index, &Default::default()).is_ok());
        }
        Ok(())
    }
}
