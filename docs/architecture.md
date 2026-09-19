# Architecture

Overwatch reads the history that coding agents already write to disk and shows
it back to you: your sessions, their conversations, what models they used, what
they cost, and how much is left of your subscription limits.

The whole design follows from one observation about that data.

## The agents' files are the database

Every supported agent writes append-only history to your home directory, and
records its usage as it goes — one record per response, turn, or message:

| Agent       | Identity                                   | Usage records                                   |
| ----------- | ------------------------------------------ | ----------------------------------------------- |
| Claude Code | `sessionId`, or a subagent run's `agentId` | `usage` on each response, repeated on its lines |
| Codex       | `session_meta` on line one                 | `token_count`, a running `total_token_usage`    |
| OpenCode    | a `session_v2` row                         | each assistant message in `session_message`     |
| Pi          | the opening `session` record               | `usage` on each assistant message               |
| Grok        | `summary.json`                             | each finished turn in `updates.jsonl`           |

A scan reads each file that changed since the last scan, whole, and counts
every usage record under the quarter hour it happened in and the provider and
model that produced it. So a period or a day counts only what was used within it — a
thread resumed after a week adds today's work to today, not its whole history —
and a session's totals are the sum of its records across every file it spans.
A model is counted under its name, the id its agent recorded less any path in
front of it, so OpenRouter's `google/gemini-3.8-flash` and Google's own
`gemini-3.8-flash` are one model; the id is still what a record is priced by.
The first index of 1,187 files and 1,261 sessions takes under two seconds; after that
a scan reads only the handful of files agents are writing to.

Reading a _conversation_ parses a whole file too, for one session at a time,
and it is fast because the file is local: about 2 ms for a median session.

## What is stored

A single SQLite file, `index.sqlite`, holding one row per session, each
session's usage by quarter hour, provider and model, and the file signatures that make
rescanning incremental. About **3.6 MB** for this corpus.

No transcript text is copied into it. That is the decision the rest of the
performance follows from: the previous engine copied every body into SQLite,
which produced a 3.8 GB database, an import that took hours, and a reader that
fetched message bodies back over IPC in 256 KB chunks.

Because the index holds nothing that cannot be rebuilt from the agents' own
files in a few seconds, **there are no migrations**. A schema change drops
the tables and rebuilds. That removes the entire class of bug where a store in
the wild has a shape the migration did not expect.

## How a scan works

1. Walk each present agent's directory and stat every file.
2. Skip every file whose modification time _and_ size match what the index
   last saw.
3. Parse the rest in parallel, one worker per core, newest first.
4. Write each file as soon as it is parsed, on a single thread, because SQLite
   has one writer and the work is all in the parsing anyway.

An unchanged corpus therefore costs a directory walk: about 10 ms. A scan runs
at startup and every five seconds after it, so a conversation you finish in
another window appears while you are still looking at the list.

A scan that runs longer than a quarter of a second — the first index, or a
rebuild — tells the window how far it has got four times a second. The newest
sessions appear within moments and older history fills in below them, while a
bar above the appearance menu counts the files read. The everyday rescan
finishes long before its first report, so it never shows the bar.

A file that cannot be read is skipped and listed under a warning at the foot of
the sidebar; it never stops the rest of a scan. A file that disappears keeps its
sessions in the index, flagged as no longer present, because history an agent
has since deleted is still history.

## Searching what was said

A search of every conversation cannot ask the index, which holds no text, so it
reads the agents' files, on every core, most recently active first, and hands
the window each session that mentions the search as it turns up. What was said
is a small part of those files and tool output most of the rest, so a file is
first looked through as bytes, and parsed only when it could hold the search:
most are passed over unread. Every OpenCode session is kept in one database,
which is asked once which sessions' records hold it, and a Codex thread's
rollouts are found by walking them once for the whole search. A search stops at
the two hundred most recent sessions it finds, and when another begins.

## Accuracy: recorded, except cost

Every number shown is one the agent itself recorded, except cost.

- **Tokens** are the agent's own counts, each counted once: a response
  repeated over several lines counts once, and a running total contributes
  what it grew by. Each record's own total is used rather than a sum of its
  parts, because agents differ on whether reasoning and cache counts are
  already included.
- **Cost** is estimated, because most agents record none. Every response is
  priced as it is counted, at the rates the models.dev catalog lists for its
  provider and model in the context tier the response reached — the catalog
  OpenCode and Pi price with. Their own figures stand in only for a model the
  catalog does not list. Grok is the exception: it reports what xAI charged for
  each turn, and that is used as it stands.
  The prices ship in `src-tauri/src/prices.json`, refreshed with
  `vp run prices`, and new prices rebuild the index. The estimate is what the
  usage costs at API prices, not what a subscription charged for it.
- **Subscription limits** are the provider's own figures. A refresh that fails
  leaves the last ones on screen with the reason, never a zero.
- **Null means unknown**, never zero. A session with no recorded usage reads as
  `—`, not as `0`.

## Subscription limits

Limits are the one thing Overwatch asks the network for. A subscription is not
an agent: one ChatGPT plan can be signed into from Codex, OpenCode and Pi at
once. So each subscription lists every place its sign-in can be kept, and every
account found is read with whichever of its sign-ins works.

| Subscription | Sign-ins read                                   | Usage endpoint                       |
| ------------ | ----------------------------------------------- | ------------------------------------ |
| Claude       | Claude Code, in the Keychain                    | `api.anthropic.com/api/oauth/usage`  |
| Codex        | Codex, OpenCode (`openai`), Pi (`openai-codex`) | `chatgpt.com/backend-api/wham/usage` |
| Grok         | Grok Build, OpenCode (`xai`), Pi (`xai`)        | `cli-chat-proxy.grok.com/v1/billing` |
| OpenCode Go  | OpenCode and Pi (`opencode-go`)                 | `opencode.ai/zen/go/v1/usage`        |

Sign-ins are grouped by the account they belong to — Codex and Grok tokens name
theirs, and an OpenCode Go key is its own — so one account held by three apps
is shown once, and two accounts twice. A sign-in is only read: renewing it
would rotate the token its app holds and sign that app out. Sign-ins are looked
for every 30 seconds and a provider is asked only when one changes or five
minutes have passed, so a sign-in renewed in its app shows within half a
minute.

Requests go through `/usr/bin/curl` with the credential on its standard input,
which keeps an HTTP client and TLS stack out of the binary and the credential
out of any process listing. The last successful read is kept in the index, so
limits show at once on launch.

Readings of a limit over the last hour give its recent pace. When a limit would
run out at that pace before it resets, the Subscriptions page says when and a
notification says so once per window, as one does when a limit is reached and
when it is available again. While a limit is used up or running out, a dot on
Subscriptions in the sidebar shows it from every page. A pace needs fifteen
minutes of rising readings, because providers report whole percents.

A menu bar item keeps the limits being worked against in sight. A subscription
is in use when a session on this machine used it in the last half hour, by the
provider each usage record names, or when its limits rose between reads, which
catches use from other devices and the providers' own apps. The item shows the
tightest limit on all usage among the subscriptions in use, or among those used
last when none is, and its ring is drawn as far round as that limit has left.
Clicking it drops down a panel with every account's limits, those in use first,
which hides once anything else is clicked. Closing the window hides it rather
than quitting, and Open at Login starts the app with its window closed, so
limits are watched until Overwatch is quit.

None of these endpoints is publicly documented. An answer that stops matching
what the reader expects is reported as changed, never shown as zero.

## Module layout

Data moves through the crate in this order:

| Module         | Responsibility                                               |
| -------------- | ------------------------------------------------------------ |
| `source/`      | Reading one agent's files; one module per agent              |
| `price.rs`     | Estimating cost from the models.dev catalog                  |
| `session.rs`   | The types those reads produce, which are also the wire types |
| `store.rs`     | The SQLite index and its queries                             |
| `index.rs`     | Keeping the index current                                    |
| `account/`     | Reading subscription limits; one module per provider         |
| `bridge.rs`    | The commands the window and the menu bar panel call          |
| `shell.rs`     | The app's menu, and what its items do                        |
| `tray.rs`      | The menu bar item that shows limits, and its panel           |
| `timestamp.rs` | Instants, as Unix milliseconds                               |
| `error.rs`     | The one failure type                                         |

There is no separate internal model: the readers produce the wire types
directly and the store round-trips them through columns of the same name.

## Measured

On this machine, against 1,187 files holding 1,261 sessions:

| Operation                          | Time    |
| ---------------------------------- | ------- |
| Cold index of the whole corpus     | ~1.7 s  |
| Rescan with one file changed       | ~17 ms  |
| Session list page, filtered/sorted | ~0.5 ms |
| Search across all sessions         | ~2.4 ms |
| Model ranking                      | ~8 ms   |
| Project ranking                    | ~3 ms   |
| Overview totals                    | ~9 ms   |
| Open a conversation (median)       | ~2 ms   |
| Open a conversation (p99)          | ~33 ms  |
| Open the largest, a 336 MB rollout | ~200 ms |
| Search what was said, first found  | ~100 ms |
| Search what was said, a rare word  | ~2 s    |
| Search what was said, a common one | ~0.6 s  |
| Index size                         | ~3.6 MB |

Timings vary with machine load; these are one run at a load average of about
five, and a quieter machine is faster. Reproduce with
`cargo run --release --example scan` from `src-tauri/`. It reads your real agent
directories, writes its index to a temporary directory, and never writes to an
agent's files. It also reports what share of each agent's tool calls came back
paired with their results, which is the check that catches a reader whose
results never land.
