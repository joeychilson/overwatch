use super::*;

#[derive(Default)]
pub struct State {
    previous: Option<Tokens>,
    precise: bool,
}
pub fn tokens(value: &Value) -> Tokens {
    let cache_read = count(&value["cached_input_tokens"]);
    let cache_write = count(&value["cache_write_input_tokens"]);
    Tokens {
        input: count(&value["input_tokens"]).saturating_sub(cache_read + cache_write),
        cache_read,
        cache_write,
        output: count(&value["output_tokens"]),
        reasoning: count(&value["reasoning_output_tokens"]),
    }
}
impl State {
    pub fn process(&mut self, data: &mut Accumulator, value: &Value, id: &str, timestamp: i64) {
        let payload = &value["payload"];
        match string(&value["type"]) {
            "session_meta" => {
                data.identity(
                    payload["id"]
                        .as_str()
                        .unwrap_or(string(&payload["session_id"])),
                );
                data.session.cwd = string(&payload["cwd"]).into();
                data.session.parent_id = payload["forked_from_id"].as_str().map(str::to_owned);
            }
            "turn_context" => {
                if let Some(model) = payload["model"].as_str() {
                    data.session.model = model.into();
                }
            }
            "token_usage_record" => {
                if !self.precise {
                    data.clear_legacy_usage();
                    self.precise = true;
                }
                data.usage(
                    format!("response:{}", payload["response_id"].as_str().unwrap_or(id)),
                    Usage {
                        timestamp,
                        model: payload["model"]
                            .as_str()
                            .unwrap_or(&data.session.model)
                            .into(),
                        provider: "openai".into(),
                        tokens: tokens(&payload["usage"]),
                        reported_cost: None,
                    },
                );
            }
            "event_msg" if payload["type"] == "token_count" => {
                log_limits(data, &payload["rate_limits"], timestamp);
                let info = &payload["info"];
                if info["total_token_usage"].is_object() {
                    let current = tokens(&info["total_token_usage"]);
                    let delta = match self.previous {
                        Some(previous) if current.total() >= previous.total() => {
                            current.delta(previous)
                        }
                        _ if info["last_token_usage"].is_object() => {
                            tokens(&info["last_token_usage"])
                        }
                        _ => Tokens::default(),
                    };
                    self.previous = Some(current);
                    if !self.precise {
                        data.usage(
                            format!("legacy:{id}"),
                            Usage {
                                timestamp,
                                model: data.session.model.clone(),
                                provider: "openai".into(),
                                tokens: delta,
                                reported_cost: None,
                            },
                        );
                    }
                }
            }
            "compacted" => data.event(
                id,
                EventKind::Compaction,
                timestamp,
                content(&payload["message"]),
                None,
            ),
            "event_msg" if payload["type"] == "context_compacted" => data.event(
                id,
                EventKind::Compaction,
                timestamp,
                "Context compacted".into(),
                None,
            ),
            "response_item" => match string(&payload["type"]) {
                "message" => {
                    let role = match string(&payload["role"]) {
                        "user" => EventKind::User,
                        "assistant" => EventKind::Assistant,
                        _ => return,
                    };
                    let text = content(&payload["content"]);
                    if ![
                        "<environment_context>",
                        "<permissions instructions>",
                        "# AGENTS.md instructions",
                    ]
                    .iter()
                    .any(|prefix| text.trim_start().starts_with(prefix))
                    {
                        data.event(id, role, timestamp, text, None);
                    }
                }
                "reasoning" => {
                    let text = content(&payload["summary"]);
                    if !text.is_empty() {
                        data.event(id, EventKind::Thinking, timestamp, text, None);
                    }
                }
                "function_call" | "custom_tool_call" => data.event(
                    payload["call_id"].as_str().unwrap_or(id),
                    EventKind::Tool,
                    timestamp,
                    content(payload.get("arguments").unwrap_or(&payload["input"])),
                    Some(string(&payload["name"])),
                ),
                "function_call_output" | "custom_tool_call_output" => {
                    let output = content(&payload["output"]);
                    let failed = explicit_failure(&output);
                    data.result(string(&payload["call_id"]), timestamp, output, failed);
                }
                _ => {}
            },
            _ => {}
        }
    }
}
fn explicit_failure(output: &str) -> Option<bool> {
    if let Ok(value) = serde_json::from_str::<Value>(output) {
        if let Some(error) = value["isError"].as_bool() {
            return Some(error);
        }
        if let Some(code) = value["exit_code"].as_i64().or(value["exitCode"].as_i64()) {
            return Some(code != 0);
        }
    }
    output.lines().take(10).find_map(|line| {
        line.strip_prefix("Process exited with code ")
            .or(line.strip_prefix("Exit code: "))
            .and_then(|s| s.trim().parse::<i32>().ok())
            .map(|n| n != 0)
    })
}
fn log_limits(data: &mut Accumulator, value: &Value, timestamp: i64) {
    let id = value["limit_id"]
        .as_str()
        .or(value["limitId"].as_str())
        .unwrap_or("codex");
    if is_spark_limit(id) {
        return;
    }
    for key in ["primary", "secondary"] {
        let window = &value[key];
        let Some(percent) = window["used_percent"]
            .as_f64()
            .or(window["usedPercent"].as_f64())
            .filter(|n| (0.0..=100.0).contains(n))
        else {
            continue;
        };
        let minutes = count(
            window
                .get("window_minutes")
                .unwrap_or(&window["windowDurationMins"]),
        ) as u32;
        let resets = time(window.get("resets_at").unwrap_or(&window["resetsAt"]));
        let bucket = format!("{id}:{key}");
        data.session.limits.retain(|sample| {
            !(sample.bucket == bucket && sample.timestamp / 60_000 == timestamp / 60_000)
        });
        data.session.limits.push(QuotaSample {
            agent: Agent::Codex,
            account_key: None,
            bucket,
            label: if minutes == 10080 {
                "Weekly".into()
            } else {
                format!("{} hour", minutes / 60)
            },
            used_percent: percent,
            window_minutes: minutes,
            resets_at: (resets > 0).then_some(resets),
            timestamp,
            source: "Session log".into(),
        });
    }
}
