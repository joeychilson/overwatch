# API

The engine is reached through thirteen Tauri commands. Rust owns discovery,
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
  `not_found`, `read_failed`, `store_failed`, `open_failed`, or `unavailable`;
  the last is the client's own, used when there is no Tauri host to answer.
  `message` is safe to display and never contains transcript content.

## Commands

| Command               | Arguments                 | Returns          |
| --------------------- | ------------------------- | ---------------- |
| `list_sessions`       | `filter: Filter`          | `SessionPage`    |
| `get_session`         | `id`                      | `Session`        |
| `get_transcript`      | `id`, `offset?`, `limit?` | `Transcript`     |
| `get_timeline`        | `id`                      | `Mark[]`         |
| `close_transcript`    | —                         | —                |
| `reveal_session`      | `id`                      | —                |
| `open_session_folder` | `id`                      | —                |
| `list_models`         | `since?`, `until?`        | `ModelUsage[]`   |
| `list_projects`       | `since?`, `until?`        | `ProjectUsage[]` |
| `get_overview`        | `since?`, `until?`        | `Overview`       |
| `get_status`          | —                         | `Status`         |
| `open_window`         | `path?`                   | —                |
| `quit`                | —                         | —                |

`reveal_session` shows the file a session's history is in, and
`open_session_folder` opens the folder it worked in, both in Finder.
`open_window` brings the app's window forward, at `path` when one is given, and
`quit` quits; the menu bar item's panel offers both.

`get_status` never waits for a scan, and no command starts one: the engine
scans at startup and every five seconds after. It emits `index_changed`,
carrying a `Status`, whenever a scan finishes or a subscription's limits are
read, and every quarter second during a long scan, when `Status.progress` holds
the files read and the files to read. It emits `open`, carrying a path such as
`/subscriptions`, to the app's window when its menu or `open_window` asks it to
show a destination; a path such as `/sessions#search` also names an element to
focus there.

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

`get_timeline` returns a `Mark` for every turn of the session, however long:
its `index`, `at`, `speaker`, whether it `failed`, and a `label` holding the
opening of what was said or the tool's name. It reads the conversation the
transcript holds, so opening a session parses it once for both.

### Periods, days and timezones

`list_models`, `list_projects` and `get_overview` count usage by when it
happened, to the quarter hour, so a session active across the start of a period
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
