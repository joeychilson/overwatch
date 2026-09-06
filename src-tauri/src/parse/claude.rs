use super::*;

pub fn process(data: &mut Accumulator, value: &Value, id: &str, timestamp: i64) {
    if let Some(cwd) = value["cwd"].as_str() {
        data.session.cwd = cwd.into();
    }
    if let Some(session) = value["sessionId"].as_str() {
        if value["isSidechain"] == true {
            data.session.parent_id = Some(format!("claude:{session}"));
        } else {
            data.identity(session);
        }
    }
    match string(&value["type"]) {
        "summary" => {
            if let Some(title) = value["summary"].as_str() {
                data.session.title = title.chars().take(160).collect();
            }
        }
        "system" if value["subtype"] == "compact_boundary" => data.event(
            id,
            EventKind::Compaction,
            timestamp,
            "Context compacted".into(),
            None,
        ),
        "assistant" | "user" => {
            let message = &value["message"];
            let assistant = value["type"] == "assistant";
            if let Some(model) = message["model"]
                .as_str()
                .filter(|model| !model.starts_with('<'))
            {
                data.session.model = model.into();
            }
            if assistant {
                let usage = &message["usage"];
                data.usage(
                    message["id"].as_str().unwrap_or(id).into(),
                    Usage {
                        timestamp,
                        model: data.session.model.clone(),
                        provider: "anthropic".into(),
                        tokens: Tokens {
                            input: count(&usage["input_tokens"]),
                            output: count(&usage["output_tokens"]),
                            cache_read: count(&usage["cache_read_input_tokens"]),
                            cache_write: count(&usage["cache_creation_input_tokens"]),
                            reasoning: 0,
                        },
                        reported_cost: None,
                    },
                );
            }
            blocks(
                data,
                id,
                if assistant {
                    EventKind::Assistant
                } else {
                    EventKind::User
                },
                timestamp,
                &message["content"],
            );
        }
        _ => {}
    }
}
