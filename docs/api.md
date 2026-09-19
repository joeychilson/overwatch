# API

The engine is reached through eighteen Tauri commands. Rust owns discovery,
parsing, every query, and the requests for subscription limits; the frontend
selects and presents. No runtime server route exists.

The commands live in `src-tauri/src/bridge.rs`; the typed client is
`src/lib/api/backend.ts`, whose types mirror `src-tauri/src/session.rs` one to
one and are written by hand.

## Conventions

- **A command returns its payload directly.** There is no envelope, no
  revision to carry, no view to open and release, and no cursor.
- **Counts and money are plain numbers.** The largest total any agent records
  is a few billion tokens, well inside what JavaScript represents exactly.
- **Instants are Unix milliseconds.**
- **Null means unknown, never zero.** `costUsd` is estimated at list prices,
  and `null` means none of the usage has a listed price; it does not mean the
  session was free.
- **Names are camelCase on the wire**, and enum values are snake_case strings
  (`claude_code`, `sign_in`).
- **A failure rejects with `{ kind, message }`.** `kind` is one of
  `not_found`, `read_failed`, `write_failed`, `store_failed`, `open_failed`,
  `invalid`, or `unavailable`; the last is the client's own, used when there is
  no Tauri host to answer.
  `message` is safe to display and never contains transcript content.

## Commands

| Command                | Arguments                  | Returns          |
| ---------------------- | -------------------------- | ---------------- |
| `list_sessions`        | `filter: Filter`           | `SessionPage`    |
| `get_session`          | `id`                       | `Session`        |
| `get_transcript`       | `id`, `offset?`, `limit?`  | `Transcript`     |
| `get_timeline`         | `id`                       | `Mark[]`         |
| `find_in_transcript`   | `id`, `query`              | `number[]`       |
| `search_conversations` | `query`, `filter`, `found` | `Searched`       |
| `stop_searching`       | —                          | —                |
| `close_transcript`     | —                          | —                |
| `reveal_session`       | `id`                       | —                |
| `open_session_folder`  | `id`                       | —                |
| `list_models`          | `since?`, `until?`         | `ModelUsage[]`   |
| `list_projects`        | `since?`, `until?`         | `ProjectUsage[]` |
| `get_overview`         | `since?`, `until?`         | `Overview`       |
| `list_hours`           | `since?`, `until?`         | `HourTotals[]`   |
| `get_status`           | —                          | `Status`         |
| `save_card`            | `name`, `png`              | `string`         |
| `open_window`          | `path?`                    | —                |
| `quit`                 | —                          | —                |

`reveal_session` shows the file a session's history is in, and
`open_session_folder` opens the folder it worked in, both in Finder.
`open_window` brings the app's window forward, at `path` when one is given, and
`quit` quits; the menu bar item's panel offers both.

`save_card` writes a picture the window drew — the overview's share card — to
the Desktop, or to the home directory when there is none. `name` carries no
extension and is reduced to lowercase words and hyphens, so it can only ever
name a file directly in that folder; a name already taken gets a number rather
than displacing what is there. `png` is the image's bytes in base64, as a
canvas's data URL carries them, and anything that is not a PNG is refused. The
answer is the path it was written to.

`get_status` never waits for a scan, and no command starts one: the engine
scans at startup and every five seconds after. It emits `index_changed`,
carrying a `Status`, whenever a scan finishes or a subscription's limits are
read, and every quarter second during a long scan, when `Status.progress` holds
the files read and the files to read. After a scan that read anything new it
emits `sessions_changed`, carrying the ids of the sessions it read anything new
of, each once, so a window showing a session still going reads that one again
and no other. It emits `open`, carrying a path such as
`/subscriptions`, to the app's window when its menu or `open_window` asks it to
show a destination; a path such as `/sessions#search` also names an element to
focus there. It emits `command`, carrying `back`, `forward`, `find`,
`find_next` or `find_previous`, to the app's window when that menu item is
chosen; a page that can find within itself does, and elsewhere Find searches
the sessions. Both are sent to that window
alone, so the window listens for them on itself: a listener for any window
hears every event, and the menu bar panel runs the same layout.

### Subscription limits

`Status.accounts` lists every subscription account with a sign-in on this
machine, whichever app holds it. Each has an `id` stable across launches, its
`provider` (`claude`, `codex`, `grok`, `open_code_go`), a `label` such as an
email address, the `via` apps holding it, `limits` (`name`, `scope` when a
limit covers one model, `usedPercent`, `resetsAt`, and `runsOutAt` when the
recent pace would use it up before it resets), `readAt`, `problem`:
`sign_in`, `unavailable` or `unrecognized` when the latest refresh failed, in
which case the limits are the last ones read, and `usedAt`, when it was last
seen in use by a session on this machine or by its limits rising between reads.

### Filtering and sorting

```ts
interface Filter {
  search?: string | null; // matches title, working directory, and model
  agents?: Agent[]; // empty means every agent
  includeSpawned?: boolean; // default false: runs an agent started itself
  since?: number | null; // used tokens at or after
  until?: number | null; // used tokens at or before
  project?: string | null; // worked in this directory, matched whole
  model?: string | null; // used this model, matched whole
  sort?: { key: SortKey; descending: boolean };
  offset?: number;
  limit?: number; // clamped to 500
}
```

`SortKey` is `updated | started | tokens | cost | title`. Every one maps to an
indexed column, so the list can never be asked for an ordering that would make
the database sort the whole table. A `SessionPage` carries the totals of the
**whole match**, not of the returned page.

`ModelUsage.model` and `ModelSlice.model` are a model's name: the id its agent
recorded, less any path in front of it, such as OpenRouter's `google/`. That
name is what `Filter.model` matches and `Filter.search` looks in. A `Turn`'s
`model` is the id as the agent recorded it.

### Reading a conversation

`get_transcript` returns a window of `Turn`s plus `total`, the number the whole
session has. `offset` counts readable turns, not source records.

The engine parses the conversation once and holds it, so paging through a long
session costs nothing further; `close_transcript` releases it when the reader
leaves. Each `Turn` carries a `speaker` (`user`, `assistant`, `reasoning`,
`tool`, `system`), its text, and — for a tool turn — the call's name,
arguments, result, and whether it failed. Nothing needs a second request.

What a harness sends as the person's but wrote itself — Codex's
`<environment_context>` and `AGENTS.md` preamble, Claude Code's reminders,
task notices and command output, Grok's `<user_info>` — is a `system` turn,
and a slash command is a `user` turn reading `/name args`.

`find_in_transcript` answers the index of every turn of the held conversation
that contains `query`, ignoring case, in order: in what was said or thought or
what the harness added, or in a tool call's name, arguments or result. A query
of nothing but space finds nothing.

`get_timeline` returns a `Mark` for every turn of the session, however long:
its `index`, `at`, `speaker`, whether it `failed`, and a `label` holding the
opening of what was said or the tool's name. It reads the conversation the
transcript holds, so opening a session parses it once for both.

### Searching what was said

`search_conversations` looks through what was said — by the person and by the
model, not thinking, tool calls or what the harness added — in the conversation
of every session `filter` matches, for `query`, ignoring case. The filter's own
`search`, ordering and window do not apply: it looks through every match, most
recently active first. No conversation's text is kept in the index, so it
reads the agents' files, passing over unread any whose bytes cannot contain the
query. `found` is a channel, on which it sends each batch of `Mention`s as they
turn up: the `session`, how many `turns` said mention the query, the `first` of
them, and an `excerpt` of it around the mention. It answers with `Searched`,
the conversations `searched` of the `total` there were, and whether it was
`capped` at the most it answers with, two hundred. A later search, or
`stop_searching`, ends one still running.

### Periods, days and timezones

`list_models`, `list_projects`, `get_overview` and `list_hours` count usage by
when it happened, to the quarter hour, so a session active across the start of a period
contributes only its usage inside the period. `Overview.sessions` counts the
sessions that used tokens in the period, each `DayTotals.sessions` those that
did that day, and `DayTotals.byAgent` splits the day by agent. `ModelUsage.daily`
splits each model's usage the same way. `ProjectUsage.project` is the directory
its sessions worked in, matched whole as `Filter.project` matches it; a session
that recorded no directory is in no project. `list_sessions` narrows to the
sessions that used tokens in the period, and totals whole sessions.

`get_overview` buckets days in this machine's own zone, which is the reader's,
so a day breaks at local midnight, and a day beside a clock change is 23 or 25
hours long rather than shifted by an hour.

`list_hours` answers a `HourTotals` for each local hour of the period with any
usage, oldest first, split by agent as a day is; the overview draws today with
it. An hour is named by the instant it starts, and every one is an hour long:
the hour repeated when clocks go back is two, and in a zone such as India's an
hour starts on the half hour of universal time. `list_sessions` narrows to an
hour as it does to any period, from its instant to the instant before the next.
