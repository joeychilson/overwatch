use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, Type,
)]
#[serde(rename_all = "lowercase")]
pub enum Agent {
    Codex,
    Claude,
    Opencode,
    Pi,
    Grok,
    Antigravity,
}

impl Agent {
    pub const ALL: [Self; 6] = [
        Self::Codex,
        Self::Claude,
        Self::Opencode,
        Self::Pi,
        Self::Grok,
        Self::Antigravity,
    ];
    pub fn id(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Claude => "claude",
            Self::Opencode => "opencode",
            Self::Pi => "pi",
            Self::Grok => "grok",
            Self::Antigravity => "antigravity",
        }
    }
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    pub input: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub output: u64,
    pub reasoning: u64,
}
impl Tokens {
    pub fn total(self) -> u64 {
        self.input + self.cache_read + self.cache_write + self.output
    }
    pub fn add(&mut self, other: Self) {
        self.input += other.input;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.output += other.output;
        self.reasoning += other.reasoning;
    }
    pub fn delta(self, previous: Self) -> Self {
        Self {
            input: self.input.saturating_sub(previous.input),
            cache_read: self.cache_read.saturating_sub(previous.cache_read),
            cache_write: self.cache_write.saturating_sub(previous.cache_write),
            output: self.output.saturating_sub(previous.output),
            reasoning: self.reasoning.saturating_sub(previous.reasoning),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    pub timestamp: i64,
    pub model: String,
    pub provider: String,
    pub tokens: Tokens,
    pub reported_cost: Option<f64>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ToolStats {
    pub name: String,
    pub calls: u32,
    pub failures: u32,
    pub completed: u32,
    pub timed: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    User,
    Assistant,
    Thinking,
    Tool,
    Compaction,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SessionEvent {
    pub id: String,
    pub kind: EventKind,
    pub timestamp: i64,
    pub text: String,
    pub model: String,
    pub tool: Option<String>,
    pub output: Option<String>,
    pub duration_ms: Option<u64>,
    pub failed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub agent: Agent,
    pub title: String,
    pub cwd: String,
    pub project: String,
    pub model: String,
    pub started_at: i64,
    pub updated_at: i64,
    pub messages: u32,
    pub turns: u32,
    pub compactions: u32,
    pub tokens: Tokens,
    pub usage: Vec<Usage>,
    pub tools: Vec<ToolStats>,
    pub limits: Vec<QuotaSample>,
    pub source_path: String,
    pub parent_id: Option<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    pub agent: Agent,
    pub path: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    pub source: Source,
    pub available: bool,
    pub sessions: u32,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourcePreview {
    pub current: Source,
    pub source: Source,
    pub sessions: u32,
    pub allowance_samples: u32,
    pub account: bool,
    pub available: bool,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub sessions: Vec<Session>,
    pub sources: Vec<SourceStatus>,
    pub scanning: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Preferences {
    pub theme: Theme,
    pub saved_models: Vec<String>,
    pub sidebar_collapsed: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            theme: Theme::Dark,
            saved_models: vec![],
            sidebar_collapsed: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEvent {
    pub index: u32,
    pub kind: EventKind,
    pub timestamp: i64,
    pub duration_ms: Option<u64>,
    pub tool: Option<String>,
    pub failed: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub session: Session,
    pub timeline: Vec<TimelineEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EventPage {
    pub events: Vec<SessionEvent>,
    pub offset: u32,
    pub total: u32,
    pub matches: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuotaSample {
    pub agent: Agent,
    pub account_key: Option<String>,
    pub bucket: String,
    pub label: String,
    pub used_percent: f64,
    pub window_minutes: u32,
    pub resets_at: Option<i64>,
    pub timestamp: i64,
    pub source: String,
}

pub(crate) fn is_spark_limit(value: &str) -> bool {
    // Spark also appears under OpenAI's metered-feature ID codex_bengalfox.
    value
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|part| part.eq_ignore_ascii_case("spark") || part.eq_ignore_ascii_case("bengalfox"))
}

impl QuotaSample {
    pub(crate) fn is_codex_spark(&self) -> bool {
        self.agent == Agent::Codex && (is_spark_limit(&self.bucket) || is_spark_limit(&self.label))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Balance {
    pub label: String,
    pub used: Option<f64>,
    pub limit: Option<f64>,
    pub remaining: Option<f64>,
    pub unit: String,
    pub unlimited: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountUsage {
    pub account_key: String,
    pub plan: Option<String>,
    pub updated_at: i64,
    pub source: String,
    pub windows: Vec<QuotaSample>,
    pub balances: Vec<Balance>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub agent: Agent,
    pub usage: Option<AccountUsage>,
    pub error: Option<crate::error::AppError>,
    pub last_attempt: i64,
    pub next_refresh_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
pub struct Accounts {
    pub accounts: Vec<AccountStatus>,
    pub samples: Vec<QuotaSample>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPayload {
    pub json: String,
    pub updated_at: i64,
    pub source: CatalogSource,
    pub warning: Option<crate::error::AppError>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CatalogSource {
    Bundled,
    Cached,
    Network,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum CatalogRequest {
    Stored,
    Refresh,
    Bundled,
    Compact,
    CompactBundled,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct IndexChanged {
    pub sessions: Option<Vec<String>>,
    pub progress: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
pub struct AccountsChanged;
