use serde_json::{Map, Value, json};

/// Keep exact offering keys and all prices used by accounting. Shared by the build
/// script and manual refresh so the offline and cached projections cannot drift.
pub fn pricing(value: &Value) -> Result<Value, &'static str> {
    let providers = value
        .as_object()
        .filter(|value| !value.is_empty())
        .ok_or("The catalog is empty")?;
    let mut result = Map::new();
    for (key, provider) in providers {
        let name = provider["name"].as_str().ok_or("Invalid provider name")?;
        let models = provider["models"]
            .as_object()
            .ok_or("Invalid provider models")?;
        let mut projection = Map::new();
        for (id, model) in models {
            let model_id = model["id"].as_str().ok_or("Invalid model identifier")?;
            let model_name = model["name"].as_str().ok_or("Invalid model name")?;
            let mut row = json!({"id": model_id, "name": model_name});
            if let Some(cost) = model.get("cost") {
                let cost = cost.as_object().ok_or("Invalid model prices")?;
                let mut prices = Map::new();
                for field in ["input", "output", "cache_read", "cache_write"] {
                    if let Some(value) = cost.get(field) {
                        if !value
                            .as_f64()
                            .is_some_and(|price| price.is_finite() && price >= 0.0)
                        {
                            return Err("Invalid model price");
                        }
                        prices.insert(field.into(), value.clone());
                    }
                }
                row["cost"] = Value::Object(prices);
            }
            projection.insert(id.clone(), row);
        }
        result.insert(key.clone(), json!({"name":name,"models":projection}));
    }
    Ok(Value::Object(result))
}
