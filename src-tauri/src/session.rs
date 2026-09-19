//! What the frontend is given.
//!
//! Every type here is a wire type: it is what a command returns, serialized as
//! camelCase JSON. There is no separate internal model and no translation
//! layer, because nothing needs one — the readers in [`crate::source`] produce
//! these types directly and the store round-trips them through columns of the
//! same name.
//!
//! Counts are plain JSON numbers. The largest total any agent records is a few
//! billion tokens, which is nowhere near the 2^53 that JavaScript represents
//! exactly, so exact-decimal strings buy nothing and cost every caller a parse.

use serde::{Deserialize, Serialize};

/// A coding agent whose history this application reads.
///
/// A closed set: an agent is supported when a reader exists for its format, so
/// there is no case for an unrecognized value. Serialized as the snake_case
/// name, which is also the key used in the database and the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Agent {
    /// Anthropic's Claude Code.
    ClaudeCode,
    /// OpenAI's Codex.
    Codex,
    /// OpenCode.
    OpenCode,
    /// Pi.
    Pi,
    /// xAI's Grok.
    GrokBuild,
}

impl Agent {
    /// Every agent, in the order the interface offers them.
    pub const ALL: [Agent; 5] = [
        Agent::ClaudeCode,
        Agent::Codex,
        Agent::OpenCode,
        Agent::Pi,
        Agent::GrokBuild,
    ];

    /// The stable key used in the database, the wire, and the interface.
    pub fn key(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude_code",
            Agent::Codex => "codex",
            Agent::OpenCode => "open_code",
            Agent::Pi => "pi",
            Agent::GrokBuild => "grok_build",
        }
    }

    /// The agent a stored key names.
    pub fn from_key(key: &str) -> Option<Agent> {
        Agent::ALL.into_iter().find(|agent| agent.key() == key)
    }
}

/// Tokens a session consumed, as its own agent accounted for them.
///
/// Every field is a count the source recorded. Nothing is inferred: an agent
/// that does not distinguish cache reads reports zero for them rather than
/// having its input tokens split by a guess.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    /// Fresh input tokens, excluding anything served from cache.
    pub input: i64,
    /// Tokens generated, including reasoning where the agent counts it there.
    pub output: i64,
    /// Input tokens served from a prompt cache.
    pub cache_read: i64,
    /// Input tokens written into a prompt cache.
    pub cache_write: i64,
    /// Reasoning tokens counted apart from the output; zero where the agent
    /// counts reasoning inside it.
    pub reasoning: i64,
    /// The agent's own total. Never recomputed from the parts above, because
    /// agents differ on whether reasoning and cache counts are already included.
    pub total: i64,
}

impl Tokens {
    /// Add another measurement, for totals across sessions.
    pub fn add(&mut self, other: Tokens) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.reasoning += other.reasoning;
        self.total += other.total;
    }

    /// Whether the source established any usage at all.
    pub fn is_empty(self) -> bool {
        self == Tokens::default()
    }
}

/// One model's share of a single session.
///
/// Usage is attributed to the model in force when it was used, so shares are
/// exact wherever the agent records which model that was.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSlice {
    /// The model's name: the id its agent recorded, less any path in front of
    /// it, such as OpenRouter's `google/`.
    pub model: String,
    /// Usage attributed to it within this session.
    pub tokens: Tokens,
    /// Estimated cost attributed to it; `None` when its model has no price.
    pub cost_usd: Option<f64>,
}

/// One session, as the list and the header of its own page show it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    /// Stable application id, `agent:native_id`. Unique across agents.
    pub id: String,
    /// Which agent recorded it.
    pub agent: Agent,
    /// The identifier the agent itself uses.
    pub native_id: String,
    /// The session's name: the one its agent generated where it keeps one,
    /// otherwise the opening prompt trimmed to a line. `None` means the session
    /// has neither yet.
    pub title: Option<String>,
    /// Working directory the session ran in.
    pub cwd: Option<String>,
    /// Git branch recorded at the time, when the agent records one.
    pub branch: Option<String>,
    /// When the session started.
    pub started_at: i64,
    /// The last activity the source recorded.
    pub updated_at: i64,
    /// Whether an agent started this run rather than a person.
    ///
    /// Agents spawn far more sessions than people do — subagents, automated
    /// reviews, forked threads — so the list separates the two.
    pub spawned: bool,
    /// What a spawned run was for, in the agent's own words.
    pub role: Option<String>,
    /// Models the session used with their shares, largest first.
    pub models: Vec<ModelSlice>,
    /// Usage as the agent accounted for it.
    pub tokens: Tokens,
    /// Cost in US dollars at list prices, as [`crate::price`] estimates it.
    ///
    /// `None` when none of its usage has a price, which is not the same as
    /// free.
    pub cost_usd: Option<f64>,
    /// Messages exchanged, or `None` until the session has been read in full.
    pub messages: Option<i64>,
    /// Tool calls made, or `None` until the session has been read in full.
    pub tools: Option<i64>,
    /// Whether the file this session came from is still present.
    pub present: bool,
}

/// Who produced one part of a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Speaker {
    /// The person.
    User,
    /// The model's spoken reply.
    Assistant,
    /// The model's recorded thinking.
    Reasoning,
    /// A tool call and its result.
    Tool,
    /// Something the harness injected: instructions, context, compaction.
    System,
}

/// One tool call, with everything needed to show it already in hand.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCall {
    /// The tool's name as the agent recorded it.
    pub name: String,
    /// Arguments, as JSON text.
    pub input: String,
    /// What the tool returned, when the source recorded it.
    pub output: Option<String>,
    /// Whether the call reported failure.
    pub failed: bool,
}

/// One readable part of a conversation, in source order.
///
/// A turn carries its text rather than a handle to fetch it with. Bodies come
/// off local disk in the same pass that produced the turn, so a second call to
/// collect them would cost a round trip to save nothing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    /// Position in the session, counting only readable turns.
    pub index: i64,
    /// Who produced it.
    pub speaker: Speaker,
    /// When, where the source records a per-message time.
    pub at: Option<i64>,
    /// The id of the model that produced it, as the agent recorded it, for
    /// assistant and reasoning turns.
    pub model: Option<String>,
    /// The text itself, already assembled from the source's blocks.
    pub text: String,
    /// The tool call, when this turn is one.
    pub tool: Option<ToolCall>,
}

/// A session's conversation, read on demand from its source file.
///
/// `turns` is the requested window; `total` is how many the session has. A
/// long session is delivered a page at a time because the payload, not the
/// reading, is what would be slow: the largest rollout on this machine holds
/// twelve thousand turns and fifty megabytes of tool output.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    /// The session this belongs to.
    pub session_id: String,
    /// Readable turns in the requested window, in source order.
    pub turns: Vec<Turn>,
    /// How many readable turns the session has in total.
    pub total: i64,
    /// Messages exchanged in the whole session.
    pub messages: i64,
    /// Tool calls made in the whole session.
    pub tools: i64,
}

impl Transcript {
    /// A whole conversation, counted from its turns: messages are what the
    /// person and the model said, and tools the calls made.
    pub fn new(session_id: String, turns: Vec<Turn>) -> Transcript {
        let messages = turns
            .iter()
            .filter(|turn| matches!(turn.speaker, Speaker::User | Speaker::Assistant))
            .count();
        let tools = turns.iter().filter(|turn| turn.tool.is_some()).count();
        Transcript {
            session_id,
            total: turns.len() as i64,
            messages: messages as i64,
            tools: tools as i64,
            turns,
        }
    }

    /// The window of turns starting at `offset`, leaving `total` unchanged.
    pub fn window(&self, offset: i64, limit: i64) -> Transcript {
        // Bounded against the turns actually held rather than against `total`,
        // which is the whole session's count and exceeds them in any transcript
        // that is itself already a window.
        let start = offset.max(0).min(self.turns.len() as i64) as usize;
        let end = start
            .saturating_add(limit.clamp(1, 2_000) as usize)
            .min(self.turns.len());
        Transcript {
            session_id: self.session_id.clone(),
            turns: self.turns[start..end].to_vec(),
            total: self.total,
            messages: self.messages,
            tools: self.tools,
        }
    }

    /// The turns that contain `query`, ignoring case, in order: in what was
    /// said or thought or what the harness added, or in a tool call's name,
    /// arguments or result. A query of nothing but space finds nothing.
    pub fn find(&self, query: &str) -> Vec<i64> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Vec::new();
        }
        let holds = |text: &str| text.to_lowercase().contains(&needle);
        self.turns
            .iter()
            .filter(|turn| {
                holds(&turn.text)
                    || turn.tool.as_ref().is_some_and(|tool| {
                        holds(&tool.name)
                            || holds(&tool.input)
                            || tool.output.as_deref().is_some_and(holds)
                    })
            })
            .map(|turn| turn.index)
            .collect()
    }

    /// Where each turn falls, for the session's timeline.
    pub fn marks(&self) -> Vec<Mark> {
        self.turns
            .iter()
            .map(|turn| Mark {
                index: turn.index,
                at: turn.at,
                speaker: turn.speaker,
                label: match (&turn.tool, turn.speaker) {
                    (Some(tool), _) => tool.name.clone(),
                    (None, Speaker::Reasoning) => String::new(),
                    (None, _) => opening(&turn.text),
                },
                failed: turn.tool.as_ref().is_some_and(|tool| tool.failed),
            })
            .collect()
    }
}

/// The longest label a mark carries, in characters.
const LABEL_LIMIT: usize = 120;

/// The first line of a text with anything on it, cut to [`LABEL_LIMIT`].
fn opening(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or_default();
    let mut label: String = line.chars().take(LABEL_LIMIT).collect();
    if line.chars().count() > LABEL_LIMIT {
        label.push('…');
    }
    label
}

/// One turn's place in a session, as its timeline draws it.
///
/// Every turn has one, however long the session: the timeline shows the whole
/// conversation, while the turns themselves arrive a page at a time.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mark {
    /// The turn's index.
    pub index: i64,
    /// When it happened, where the source records a time per message.
    pub at: Option<i64>,
    /// Who produced it.
    pub speaker: Speaker,
    /// What it was: the opening of what was said, or the tool's name.
    pub label: String,
    /// Whether it is a tool call that failed.
    pub failed: bool,
}

/// How a caller narrows the session list.
///
/// Every field is optional and an omitted field filters nothing. The whole
/// filter is answered afresh each time it is sent, so there is no view to
/// open, no cursor to carry, and nothing to release afterwards.
///
/// A period, from `since` or `until`, also changes what each session counts:
/// its tokens, cost and models are only what it used inside the period, and
/// the list is ordered and totalled by those.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Filter {
    /// Match against title, working directory, and model name.
    pub search: Option<String>,
    /// Restrict to these agents.
    pub agents: Vec<Agent>,
    /// Include runs an agent spawned for itself.
    pub include_spawned: bool,
    /// Only sessions that used tokens at or after this instant, counting only
    /// what they used from then.
    pub since: Option<i64>,
    /// Only sessions that used tokens at or before this instant, counting only
    /// what they used until then.
    pub until: Option<i64>,
    /// Only sessions that worked in this directory, matched whole.
    pub project: Option<String>,
    /// Only sessions that used this model, matched whole.
    pub model: Option<String>,
    /// How to order the result.
    pub sort: Sort,
    /// Rows to skip, for scrolling.
    pub offset: i64,
    /// Rows to return. Clamped to a sane maximum by the store.
    pub limit: i64,
}

/// How the session list is ordered.
#[derive(Debug, Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Sort {
    /// The column ordered on.
    pub key: SortKey,
    /// Largest, newest, or Z-to-A first.
    pub descending: bool,
}

/// A column the session list can be ordered by.
///
/// Closed, and every value maps to an indexed column, so the list cannot be
/// asked for an ordering that would make the database sort the whole table.
/// Within a period, tokens and cost are what was used in it, so ordering by
/// them sorts the sessions of that period instead.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SortKey {
    /// Most recent activity.
    #[default]
    Updated,
    /// When the session started.
    Started,
    /// Total tokens.
    Tokens,
    /// Cost in dollars.
    Cost,
    /// Title, alphabetically.
    Title,
}

impl SortKey {
    /// The column this orders on.
    pub fn column(self) -> &'static str {
        match self {
            SortKey::Updated => "updated_at",
            SortKey::Started => "started_at",
            SortKey::Tokens => "total_tokens",
            SortKey::Cost => "cost_usd",
            SortKey::Title => "title",
        }
    }
}

/// A page of the session list, with the totals of the whole match.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    /// The requested window of rows.
    pub sessions: Vec<Session>,
    /// How many sessions match the filter, ignoring the window.
    pub total: i64,
    /// Tokens across every matching session, not only this page.
    pub tokens: Tokens,
    /// Estimated cost across every match; `None` when none of it is priced.
    pub cost_usd: Option<f64>,
}

/// One model's share of recorded work.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsage {
    /// The model's name: the id its agents recorded, less any path in front
    /// of it, such as OpenRouter's `google/`.
    pub model: String,
    /// Agents that used it.
    pub agents: Vec<Agent>,
    /// Sessions it appeared in.
    pub sessions: i64,
    /// Usage attributed to it.
    pub tokens: Tokens,
    /// Estimated cost attributed to it; `None` when it has no price.
    pub cost_usd: Option<f64>,
    /// Its usage on each local day of the period it was used, oldest first.
    pub daily: Vec<ModelDay>,
}

/// One model's usage on one local day.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDay {
    /// Local midnight at the start of the day.
    pub day: i64,
    /// Tokens it took that day.
    pub tokens: i64,
    /// Its estimated cost that day; `None` when it has no price.
    pub cost_usd: Option<f64>,
}

/// One project's share of recorded work, a project being the directory its
/// sessions worked in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUsage {
    /// The working directory, as the sessions recorded it.
    pub project: String,
    /// Sessions that worked in it.
    pub sessions: i64,
    /// Usage recorded in it.
    pub tokens: Tokens,
    /// Estimated cost recorded in it; `None` when none of it is priced.
    pub cost_usd: Option<f64>,
}

/// A subscription whose usage limits this application reads.
///
/// Not an [`Agent`]: one subscription can be signed into from several agents,
/// and read with a sign-in from any of them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    /// Anthropic's Claude plans.
    Claude,
    /// OpenAI's ChatGPT plans, whose limits Codex reports.
    Codex,
    /// xAI's SuperGrok plans.
    Grok,
    /// OpenCode's Go plan.
    OpenCodeGo,
}

impl Provider {
    /// Every subscription, in the order the interface lists them.
    pub const ALL: [Provider; 4] = [
        Provider::Claude,
        Provider::Codex,
        Provider::Grok,
        Provider::OpenCodeGo,
    ];

    /// The stable key used in the database and in account ids.
    pub fn key(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
            Provider::Grok => "grok",
            Provider::OpenCodeGo => "open_code_go",
        }
    }

    /// The subscription as a person names it.
    pub fn name(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
            Provider::Grok => "Grok",
            Provider::OpenCodeGo => "OpenCode Go",
        }
    }

    /// The subscription that usage served by a model provider draws on, by the
    /// name agents give the provider; `None` for one paid as it goes.
    pub fn serving(provider: &str) -> Option<Provider> {
        match provider {
            "anthropic" => Some(Provider::Claude),
            "openai" | "openai-codex" => Some(Provider::Codex),
            "xai" => Some(Provider::Grok),
            "opencode-go" => Some(Provider::OpenCodeGo),
            _ => None,
        }
    }
}

/// One account of a subscription, with its limits as the provider last
/// reported them.
///
/// When the latest attempt failed, `problem` says why and the limits are the
/// last ones read successfully, as of `read_at`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    /// Stable across launches: the subscription and the account within it.
    pub id: String,
    /// The subscription.
    pub provider: Provider,
    /// What tells the account apart from others of the same subscription, such
    /// as an email address.
    pub label: Option<String>,
    /// The plan the provider named, such as `pro`.
    pub plan: Option<String>,
    /// The apps holding a sign-in to the account.
    pub via: Vec<String>,
    /// Every limit the provider reported, in its own order.
    pub limits: Vec<Limit>,
    /// When the limits were read; `None` until a read has succeeded.
    pub read_at: Option<i64>,
    /// Why the latest attempt failed; `None` after a success.
    pub problem: Option<Problem>,
    /// When it was last seen in use: by a session on this machine, or by its
    /// limits rising between reads, wherever it was used from.
    pub used_at: Option<i64>,
}

impl Account {
    /// How recently a subscription must have been used to count as in use.
    pub const IN_USE: i64 = 30 * 60_000;
}

/// One usage limit of a subscription.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Limit {
    /// The window it covers, such as `5 hours` or `Weekly`.
    pub name: String,
    /// The one model it applies to, such as `Opus`; `None` when it applies to
    /// all usage.
    pub scope: Option<String>,
    /// How much has been used, from 0; above 100 once exceeded.
    pub used_percent: f64,
    /// When it resets.
    pub resets_at: Option<i64>,
    /// When it runs out at the recent rate of use, if that is before it resets.
    pub runs_out_at: Option<i64>,
}

/// Why a subscription's limits could not be refreshed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Problem {
    /// Every sign-in to the account has expired or was refused; an app holding
    /// one must renew it.
    SignIn,
    /// The provider could not be reached, or asked for fewer requests.
    Unavailable,
    /// The provider answered with something this version does not understand.
    Unrecognized,
}

/// Totals for the overview, over a requested period.
///
/// Usage and cost are what was used within the period, dated by when it was
/// used rather than by when its session was last active.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// Sessions that used tokens in the period.
    pub sessions: i64,
    /// Usage within the period.
    pub tokens: Tokens,
    /// Estimated cost within the period; `None` when none of it is priced.
    pub cost_usd: Option<f64>,
    /// Per-agent totals, busiest first.
    pub by_agent: Vec<AgentTotals>,
    /// Daily totals, oldest first, for charting.
    pub daily: Vec<DayTotals>,
}

/// One agent's totals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTotals {
    /// The agent.
    pub agent: Agent,
    /// Its sessions in the period.
    pub sessions: i64,
    /// Its usage.
    pub tokens: Tokens,
    /// Its estimated cost; `None` when none of its usage is priced.
    pub cost_usd: Option<f64>,
}

/// One local day's totals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTotals {
    /// Local midnight at the start of the day.
    pub day: i64,
    /// Sessions that used tokens that day.
    pub sessions: i64,
    /// Usage that day.
    pub tokens: Tokens,
    /// Estimated cost that day; `None` when none of it is priced.
    pub cost_usd: Option<f64>,
    /// Each agent's share of the day.
    pub by_agent: Vec<AgentDay>,
}

/// One local hour's totals.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HourTotals {
    /// The instant the local hour starts. Beside a clock change an hour is
    /// still an hour, so the hour repeated when clocks go back is two, each
    /// with its own instant.
    pub hour: i64,
    /// Sessions that used tokens in the hour.
    pub sessions: i64,
    /// Usage in the hour.
    pub tokens: Tokens,
    /// Estimated cost in the hour; `None` when none of it is priced.
    pub cost_usd: Option<f64>,
    /// Each agent's share of the hour.
    pub by_agent: Vec<AgentDay>,
}

/// One agent's share of a day, or of an hour.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDay {
    /// The agent.
    pub agent: Agent,
    /// Its tokens in the span, by its own count.
    pub tokens: i64,
    /// Its estimated cost in the span; `None` when none of it is priced.
    pub cost_usd: Option<f64>,
}

/// What the engine knows so far: how indexing went, and each subscription's
/// limits.
///
/// Returned by the status command and carried by the `index_changed` event
/// after every scan and every read of limits, so the window follows both
/// without polling.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Whether a scan is running now.
    pub scanning: bool,
    /// Source files actually parsed, the rest being unchanged since last time.
    pub files_read: i64,
    /// How far a long scan has got, as files read and files to read: `None`
    /// when no scan is running, and for one too quick to be worth showing.
    pub progress: Option<(i64, i64)>,
    /// Sessions in the index.
    pub sessions: i64,
    /// Agents whose home directory was found on this machine.
    pub agents: Vec<Agent>,
    /// Sources that could not be read, with the reason.
    pub problems: Vec<String>,
    /// Every subscription account with a sign-in on this machine.
    pub accounts: Vec<Account>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_keys_round_trip() {
        for agent in Agent::ALL {
            assert_eq!(Agent::from_key(agent.key()), Some(agent));
        }
        assert_eq!(Agent::from_key("nonexistent"), None);
    }

    #[test]
    fn agent_keys_match_the_wire_encoding() {
        // The interface keys off the same strings the database stores, so a
        // rename in one place must not silently diverge from the other.
        for agent in Agent::ALL {
            let json = serde_json::to_string(&agent).expect("agent serializes");
            assert_eq!(json, format!("\"{}\"", agent.key()));
        }
    }

    #[test]
    fn totals_accumulate_every_component() {
        let mut sum = Tokens::default();
        assert!(sum.is_empty());
        sum.add(Tokens {
            input: 1,
            output: 2,
            cache_read: 3,
            cache_write: 4,
            reasoning: 5,
            total: 15,
        });
        sum.add(Tokens {
            input: 10,
            output: 20,
            cache_read: 30,
            cache_write: 40,
            reasoning: 50,
            total: 150,
        });
        assert_eq!(
            sum,
            Tokens {
                input: 11,
                output: 22,
                cache_read: 33,
                cache_write: 44,
                reasoning: 55,
                total: 165,
            }
        );
        assert!(!sum.is_empty());
    }

    #[test]
    fn a_window_stays_inside_the_turns_it_holds() {
        let turn = |index: i64| Turn {
            index,
            speaker: Speaker::User,
            at: None,
            model: None,
            text: format!("turn {index}"),
            tool: None,
        };
        let whole = Transcript {
            session_id: "codex:a".into(),
            turns: (0..10).map(turn).collect(),
            total: 10,
            messages: 10,
            tools: 0,
        };

        assert_eq!(whole.window(0, 3).turns.len(), 3);
        assert_eq!(whole.window(8, 5).turns.len(), 2, "clipped at the end");
        assert!(
            whole.window(10, 5).turns.is_empty(),
            "past the end is empty"
        );
        assert_eq!(whole.window(-5, 2).turns[0].index, 0, "before the start");
        // Every window reports the whole session's count, not the page's.
        assert_eq!(whole.window(8, 5).total, 10);

        // A window of a window: `total` exceeds the turns held, and an offset
        // between the two would slice out of bounds if it were the bound.
        let page = whole.window(5, 3);
        assert_eq!(page.turns.len(), 3);
        assert_eq!(page.total, 10);
        assert!(page.window(7, 2).turns.is_empty());
        assert_eq!(page.window(1, 9).turns.len(), 2);
        // And an absurd request is clamped rather than overflowing.
        assert_eq!(whole.window(i64::MAX, i64::MAX).turns.len(), 0);
        assert_eq!(whole.window(0, i64::MAX).turns.len(), 10);
    }

    #[test]
    fn finding_looks_through_everything_a_turn_holds_ignoring_case() {
        let said = |index: i64, speaker: Speaker, text: &str| Turn {
            index,
            speaker,
            at: None,
            model: Some("gpt-parser".into()),
            text: text.into(),
            tool: None,
        };
        let call = |index: i64, name: &str, input: &str, output: Option<&str>| Turn {
            tool: Some(ToolCall {
                name: name.into(),
                input: input.into(),
                output: output.map(Into::into),
                failed: false,
            }),
            ..said(index, Speaker::Tool, "")
        };
        let whole = Transcript::new(
            "codex:a".into(),
            vec![
                said(0, Speaker::User, "Fix the PARSER in the École module"),
                said(1, Speaker::Reasoning, "The parser drops the last token."),
                call(2, "Read", r#"{"path":"src/parser.rs"}"#, Some("fn parse()")),
                call(3, "Bash", "cargo test", Some("thread 'parser' panicked")),
                call(4, "ParserCheck", "{}", None),
                said(5, Speaker::System, "<environment_context>"),
                said(6, Speaker::Assistant, "Done."),
            ],
        );

        assert_eq!(whole.find("parser"), [0, 1, 2, 3, 4]);
        assert_eq!(
            whole.find("  PANICKED "),
            [3],
            "surrounding space is ignored"
        );
        assert_eq!(whole.find("école"), [0], "case is ignored beyond ASCII");
        assert_eq!(whole.find("environment"), [5]);
        // The model is who spoke, not what was said.
        assert!(whole.find("gpt").is_empty());
        assert!(whole.find("   ").is_empty());
        assert!(whole.find("nowhere").is_empty());
    }
}
