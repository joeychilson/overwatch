use super::*;

pub fn process(data: &mut Accumulator, value: &Value, id: &str, timestamp: i64) {
    match string(&value["type"]) {
        "session" => {
            data.identity(string(&value["id"]));
            data.session.cwd = string(&value["cwd"]).into();
        }
        "session_info" => {
            if let Some(name) = value["name"].as_str() {
                data.session.title = name.into();
            }
        }
        "model_change" => data.session.model = string(&value["modelId"]).into(),
        "compaction" => data.event(
            id,
            EventKind::Compaction,
            timestamp,
            content(&value["summary"]),
            None,
        ),
        "message" => {
            let message = &value["message"];
            if let Some(model) = message["model"].as_str() {
                data.session.model = model.into();
            }
            match string(&message["role"]) {
                "toolResult" => data.result(
                    string(&message["toolCallId"]),
                    timestamp,
                    content(&message["content"]),
                    message["isError"].as_bool(),
                ),
                "assistant" | "user" => {
                    let assistant = message["role"] == "assistant";
                    if assistant {
                        let usage = &message["usage"];
                        data.usage(
                            id.into(),
                            Usage {
                                timestamp,
                                model: data.session.model.clone(),
                                provider: string(&message["provider"]).into(),
                                tokens: Tokens {
                                    input: count(&usage["input"]),
                                    output: count(&usage["output"]),
                                    cache_read: count(&usage["cacheRead"]),
                                    cache_write: count(&usage["cacheWrite"]),
                                    reasoning: 0,
                                },
                                reported_cost: usage["cost"]["total"]
                                    .as_f64()
                                    .filter(|n| *n >= 0.0),
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
        _ => {}
    }
}
