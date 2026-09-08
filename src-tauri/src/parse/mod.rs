mod claude;
mod codex;
mod grok;
mod pi;

// Bump when normalized session data changes so unchanged histories are reindexed.
pub const VERSION: u32 = 2;

use crate::{data::*, error::Result};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{BufRead, BufReader, Read, Seek, SeekFrom},
    path::Path,
};

pub fn string(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}
pub fn count(value: &Value) -> u64 {
    value.as_u64().unwrap_or(0).min(9_007_199_254_740_991)
}
pub fn time(value: &Value) -> i64 {
    value
        .as_i64()
        .map(|n| {
            if n < 10_000_000_000 {
                n.saturating_mul(1000)
            } else {
                n
            }
        })
        .or_else(|| {
            value
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|d| d.timestamp_millis())
        })
        .unwrap_or(0)
}
pub fn content(value: &Value) -> String {
    match value {
        Value::String(s) => s.to_owned(),
        Value::Array(items) => items
            .iter()
            .filter_map(|v| v.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n\n"),
        Value::Null => String::new(),
        Value::Object(object) if object.get("text").is_some_and(Value::is_string) => {
            string(&value["text"]).into()
        }
        _ => value.to_string(),
    }
}
fn clip(mut text: String) -> String {
    if text.len() > 60_000 {
        let mut end = 60_000;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        text.push_str("\n\n[Display limited to 60 KB. Full content remains in the source log.]");
    }
    text
}

pub struct Accumulator {
    pub session: Session,
    pub events: Vec<SessionEvent>,
    detailed: bool,
    usage: BTreeMap<String, Usage>,
    tools: BTreeMap<String, ToolStats>,
    pending: HashMap<String, (String, i64, Option<usize>)>,
    seen: HashSet<String>,
}
impl Accumulator {
    pub fn new(agent: Agent, path: &Path, detailed: bool) -> Self {
        Self {
            session: Session {
                id: format!("{}:{}", agent.id(), path.display()),
                agent,
                title: String::new(),
                cwd: String::new(),
                project: String::new(),
                model: "Unknown model".into(),
                started_at: 0,
                updated_at: 0,
                messages: 0,
                turns: 0,
                compactions: 0,
                tokens: Tokens::default(),
                usage: vec![],
                tools: vec![],
                limits: vec![],
                source_path: path.to_string_lossy().into_owned(),
                parent_id: None,
                warnings: vec![],
            },
            events: vec![],
            detailed,
            usage: BTreeMap::new(),
            tools: BTreeMap::new(),
            pending: HashMap::new(),
            seen: HashSet::new(),
        }
    }
    pub fn identity(&mut self, id: &str) {
        if !id.is_empty() {
            self.session.id = format!("{}:{id}", self.session.agent.id());
        }
    }
    pub fn touch(&mut self, timestamp: i64) {
        if timestamp > 0 {
            if self.session.started_at == 0 || timestamp < self.session.started_at {
                self.session.started_at = timestamp;
            }
            self.session.updated_at = self.session.updated_at.max(timestamp);
        }
    }
    pub fn event(
        &mut self,
        id: &str,
        kind: EventKind,
        timestamp: i64,
        text: String,
        tool: Option<&str>,
    ) {
        if !self.seen.insert(id.to_owned()) {
            return;
        }
        self.touch(timestamp);
        match kind {
            EventKind::User => {
                self.session.turns += 1;
                if self.session.title.is_empty() {
                    self.session.title = text
                        .lines()
                        .find(|line| !line.trim().is_empty() && !line.starts_with('<'))
                        .unwrap_or(&text)
                        .chars()
                        .take(160)
                        .collect();
                }
                self.session.messages += 1;
            }
            EventKind::Assistant => self.session.messages += 1,
            EventKind::Compaction => self.session.compactions += 1,
            _ => {}
        }
        if let Some(name) = tool {
            self.tools
                .entry(name.into())
                .or_insert_with(|| ToolStats {
                    name: name.into(),
                    ..Default::default()
                })
                .calls += 1;
            self.pending.insert(
                id.into(),
                (
                    name.into(),
                    timestamp,
                    self.detailed.then_some(self.events.len()),
                ),
            );
        }
        if self.detailed {
            self.events.push(SessionEvent {
                id: id.into(),
                kind,
                timestamp,
                text: clip(text),
                model: self.session.model.clone(),
                tool: tool.map(str::to_owned),
                output: None,
                duration_ms: None,
                failed: None,
            });
        }
    }
    pub fn result(&mut self, id: &str, timestamp: i64, output: String, failed: Option<bool>) {
        self.touch(timestamp);
        if let Some((name, start, index)) = self.pending.remove(id) {
            let duration =
                (timestamp >= start && start > 0).then_some(timestamp.saturating_sub(start) as u64);
            if let Some(stats) = self.tools.get_mut(&name) {
                stats.completed += 1;
                stats.timed += u32::from(duration.is_some());
                stats.failures += u32::from(failed == Some(true));
                stats.duration_ms += duration.unwrap_or(0);
            }
            if let Some(event) = index.and_then(|i| self.events.get_mut(i)) {
                event.output = Some(clip(output));
                event.failed = failed;
                event.duration_ms = duration;
            }
        }
    }
    pub fn usage(&mut self, key: String, usage: Usage) {
        if usage.tokens.total() > 0 || usage.reported_cost.is_some() {
            self.usage.insert(key, usage);
        }
    }
    pub fn stream(
        &mut self,
        id: &str,
        kind: EventKind,
        timestamp: i64,
        text: String,
        continuing: bool,
    ) {
        if continuing {
            if let Some(event) = self.events.last_mut().filter(|event| event.kind == kind)
                && event.text.len() < 60_000
            {
                event.text.push_str(&text);
                event.text = clip(std::mem::take(&mut event.text));
            }
        } else {
            self.event(id, kind, timestamp, text, None);
        }
    }
    pub fn summary(&self) -> Session {
        let mut session = self.session.clone();
        session.project = Path::new(&session.cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("Unassigned")
            .into();
        if session.title.is_empty() {
            session.title = format!("{} session", session.project);
        }
        session.usage = self.usage.values().cloned().collect();
        session.usage.sort_by_key(|u| u.timestamp);
        for usage in &session.usage {
            session.tokens.add(usage.tokens);
        }
        session.tools = self.tools.values().cloned().collect();
        session.tools.sort_by_key(|t| std::cmp::Reverse(t.calls));
        session
    }
}

#[cfg(test)]
mod tests;

pub struct Cursor {
    pub data: Accumulator,
    offset: u64,
    length: u64,
    line: u64,
    identity: u128,
    modified: Option<std::time::SystemTime>,
    anchor: Vec<u8>,
    malformed: u32,
    codex: codex::State,
    grok: grok::State,
}
impl Cursor {
    pub fn new(agent: Agent, path: &Path, detailed: bool) -> Self {
        Self {
            data: Accumulator::new(agent, path, detailed),
            offset: 0,
            length: 0,
            line: 0,
            identity: 0,
            modified: None,
            anchor: vec![],
            malformed: 0,
            codex: codex::State::default(),
            grok: grok::State::default(),
        }
    }
    pub fn read(&mut self, path: &Path) -> Result<()> {
        let mut file = File::open(path)?;
        let meta = file.metadata()?;
        #[cfg(unix)]
        let identity = {
            use std::os::unix::fs::MetadataExt;
            ((meta.dev() as u128) << 64) | meta.ino() as u128
        };
        #[cfg(not(unix))]
        let identity = meta
            .created()?
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let modified = meta.modified()?;
        let mut anchor = vec![0; self.anchor.len()];
        if meta.len() >= self.offset && self.offset > 0 {
            file.seek(SeekFrom::Start(self.offset - self.anchor.len() as u64))?;
            file.read_exact(&mut anchor)?;
        }
        if meta.len() < self.offset
            || (self.offset > 0
                && meta.len() == self.length
                && self.modified.is_some_and(|previous| previous != modified))
            || (self.identity != 0 && identity != self.identity)
            || anchor != self.anchor
        {
            *self = Self::new(self.data.session.agent, path, self.data.detailed);
        }
        self.identity = identity;
        self.length = meta.len();
        self.modified = Some(modified);
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file);
        let mut line = Vec::new();
        loop {
            line.clear();
            let bytes = reader.read_until(b'\n', &mut line)?;
            if bytes == 0 || line.last() != Some(&b'\n') {
                break;
            }
            self.offset += bytes as u64;
            self.line += 1;
            self.anchor = line[line.len().saturating_sub(128)..].to_vec();
            match serde_json::from_slice::<Value>(&line) {
                Ok(value) => self.process(&value),
                Err(_) if line.iter().all(u8::is_ascii_whitespace) => {}
                Err(_) => self.malformed += 1,
            }
        }
        if self.data.session.agent == Agent::Grok {
            grok::metadata(&mut self.data, path)?;
        }
        Ok(())
    }
    pub fn process(&mut self, value: &Value) {
        let generated = self.line.to_string();
        let id = value["uuid"]
            .as_str()
            .or(value["id"].as_str())
            .unwrap_or(&generated);
        let timestamp = time(&value["timestamp"]);
        self.data.touch(timestamp);
        match self.data.session.agent {
            Agent::Codex => self.codex.process(&mut self.data, value, id, timestamp),
            Agent::Claude => claude::process(&mut self.data, value, id, timestamp),
            Agent::Pi => pi::process(&mut self.data, value, id, timestamp),
            Agent::Grok => self.grok.process(&mut self.data, value, id, timestamp),
            _ => {}
        }
    }
    pub fn summary(&self) -> Session {
        let mut session = self.data.summary();
        if self.malformed > 0 {
            session
                .warnings
                .push(format!("{} malformed records skipped", self.malformed));
        }
        session
    }
}

pub fn blocks(data: &mut Accumulator, id: &str, role: EventKind, timestamp: i64, value: &Value) {
    if let Some(text) = value.as_str() {
        data.event(id, role, timestamp, text.into(), None);
        return;
    }
    if let Some(items) = value.as_array() {
        for (index, block) in items.iter().enumerate() {
            let key = format!("{id}:{index}");
            match string(&block["type"]) {
                "text" => data.event(&key, role, timestamp, string(&block["text"]).into(), None),
                "thinking" => data.event(
                    &key,
                    EventKind::Thinking,
                    timestamp,
                    string(&block["thinking"]).into(),
                    None,
                ),
                "tool_use" | "toolCall" => data.event(
                    block["id"].as_str().unwrap_or(&key),
                    EventKind::Tool,
                    timestamp,
                    content(block.get("input").unwrap_or(&block["arguments"])),
                    Some(string(&block["name"])),
                ),
                "tool_result" => data.result(
                    string(&block["tool_use_id"]),
                    timestamp,
                    content(&block["content"]),
                    block["is_error"].as_bool(),
                ),
                _ => {}
            }
        }
    }
}
