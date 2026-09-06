use super::*;

#[derive(Default)]
pub struct State {
    stream: Option<EventKind>,
}
impl State {
    pub fn process(&mut self, data: &mut Accumulator, value: &Value, id: &str, timestamp: i64) {
        let params = &value["params"];
        data.identity(string(&params["sessionId"]));
        let update = &params["update"];
        if let Some(model) = update["_meta"]["modelId"].as_str() {
            data.session.model = model.into();
        }
        match string(&update["sessionUpdate"]) {
            "user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk" => {
                let kind = match string(&update["sessionUpdate"]) {
                    "user_message_chunk" => EventKind::User,
                    "agent_message_chunk" => EventKind::Assistant,
                    _ => EventKind::Thinking,
                };
                data.stream(
                    id,
                    kind,
                    timestamp,
                    content(&update["content"]),
                    self.stream == Some(kind),
                );
                self.stream = Some(kind);
            }
            "tool_call" => {
                self.stream = None;
                data.event(
                    string(&update["toolCallId"]),
                    EventKind::Tool,
                    timestamp,
                    content(&update["rawInput"]),
                    Some(
                        update["_meta"]["x.ai/tool"]
                            .as_str()
                            .unwrap_or(string(&update["title"])),
                    ),
                );
            }
            "tool_call_update"
                if update["status"] == "completed" || update["status"] == "failed" =>
            {
                let output = update["content"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .map(|item| content(&item["content"]))
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_else(|| content(&update["rawOutput"]));
                data.result(
                    string(&update["toolCallId"]),
                    timestamp,
                    output,
                    Some(update["status"] == "failed"),
                );
            }
            "turn_completed" => {
                self.stream = None;
                let usage = &update["usage"];
                if let Some(models) = usage["modelUsage"].as_object() {
                    for (model, usage) in models {
                        add_usage(
                            data,
                            update["prompt_id"].as_str().unwrap_or(id),
                            timestamp,
                            model,
                            usage,
                        );
                    }
                } else {
                    let model = data.session.model.clone();
                    add_usage(data, id, timestamp, &model, usage);
                }
            }
            _ => {}
        }
    }
}
fn add_usage(data: &mut Accumulator, id: &str, timestamp: i64, model: &str, value: &Value) {
    let cache_read = count(&value["cachedReadTokens"]);
    let cache_write = count(&value["cacheCreationTokens"]);
    data.usage(
        format!("{id}:{model}"),
        Usage {
            timestamp,
            model: model.into(),
            provider: "xai".into(),
            tokens: Tokens {
                input: count(&value["inputTokens"]).saturating_sub(cache_read + cache_write),
                cache_read,
                cache_write,
                output: count(&value["outputTokens"]),
                reasoning: count(&value["reasoningTokens"]),
            },
            reported_cost: None,
        },
    );
}
pub fn metadata(data: &mut Accumulator, path: &Path) -> Result<()> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    let raw = match std::fs::read(parent.join("summary.json")) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    let value: Value = serde_json::from_slice(&raw)?;
    if let Some(cwd) = value["info"]["cwd"].as_str() {
        data.session.cwd = cwd.into();
    }
    if let Some(title) = value["generated_title"].as_str() {
        data.session.title = title.into();
    }
    if let Some(model) = value["current_model_id"].as_str() {
        data.session.model = model.into();
    }
    data.touch(time(&value["created_at"]));
    Ok(())
}
