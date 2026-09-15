# Agents

Overwatch supports five agents. An agent appears only if its history directory
exists, so a machine without Codex never pays for looking and never reports a
problem about it.

Each reader lives in `src-tauri/src/source/`, one module per agent.

## Where history lives

| Agent       | Location                                                   | Shape                      |
| ----------- | ---------------------------------------------------------- | -------------------------- |
| Claude Code | `~/.claude/projects/<slug>/<uuid>.jsonl`                   | one file per session       |
| Codex       | `~/.codex/sessions/**` and `~/.codex/archived_sessions/**` | one rollout per thread     |
| OpenCode    | `~/.local/share/opencode/opencode.db`                      | one database, all sessions |
| Pi          | `~/.pi/agent/sessions/<slug>/*.jsonl`                      | one file per session       |
| Grok        | `~/.grok/sessions/<encoded cwd>/<id>/`                     | one directory per session  |

Overwatch only ever reads these. The OpenCode database is opened read-only,
because OpenCode may be running and writing to it.

## What each agent establishes

|                       | Claude Code                               | Codex              | OpenCode                             | Pi                                 | Grok              |
| --------------------- | ----------------------------------------- | ------------------ | ------------------------------------ | ---------------------------------- | ----------------- |
| Title                 | generated (`ai-title`), else first prompt | first prompt       | `title` column                       | first prompt                       | `generated_title` |
| Working directory     | ✓                                         | ✓                  | ✓                                    | ✓                                  | ✓                 |
| Git branch            | ✓                                         | —                  | —                                    | —                                  | ✓                 |
| Token breakdown       | ✓                                         | ✓                  | ✓                                    | ✓                                  | ✓                 |
| **Cost**              | priced as `anthropic`                     | priced as `openai` | priced as `providerID`, else its own | priced as `provider`, else its own | xAI's charge      |
| Usage counted per     | response                                  | turn               | message                              | message                            | turn              |
| Per-model split       | ✓ exact                                   | ✓ exact            | ✓ exact                              | ✓ exact                            | ✓ exact           |
| Spawned runs          | subagent files (`agentId`)                | `source.subagent`  | non-null `parent_id`                 | —                                  | —                 |
| Subscription sign-ins | Claude                                    | Codex              | Codex, Grok, OpenCode Go             | Codex, Grok, OpenCode Go           | Grok              |

Blank means the agent does not record it, and Overwatch shows nothing rather
than a guess. Cost is the exception: it is estimated from the models.dev catalog
under the provider named, except that Grok reports what xAI charged. A model the
catalog does not list, with no figure of the agent's own, shows `—` in the cost
column while still showing its tokens.

## Details worth knowing

**Claude Code** writes a response one line per content block, and each line
repeats the response's `usage` as it stood when that block was written. A
response — one `message.id` and `requestId` — is therefore counted once, from
its last line; adding every line counted most responses several times over. A
subagent run has its own file under `<session>/subagents/` whose records carry
the parent's `sessionId`, so its `agentId` identifies it and it is listed as a
spawned run. A forked subagent's file opens with a `fork-context-ref` record and
a copy of the parent's response that started it, which is the parent's usage,
so a fork counts only the responses after its first user record; counting the
copy counted that response once more per fork. Each response is priced at
Anthropic's rates, except that cache
writes kept for an hour (`cache_creation.ephemeral_1h_input_tokens`) cost twice
the input rate rather than the catalog's five-minute write rate. Claude Code's
own `cost-state` is only a running total for the whole session, background
calls such as title generation included, so it cannot say when the money was
spent and is not used; priced per response, most Opus sessions here came
within 3% of it. Thinking tokens are counted inside `output_tokens` and not
reported apart.

**Codex** writes `token_count` repeatedly, each carrying `total_token_usage`, a
running total for the thread. A turn's usage is what that total grew by, dated
by its record, attributed to the model the thread was using, and priced at
OpenAI's rates in the tier set by the latest request's input
(`last_token_usage`). Reasoning is counted inside `output_tokens`. The total
starts again from zero when a thread is resumed, so a drop is a restart, not a
correction. A resumed thread may also continue in a new rollout that keeps the
thread's id, points at the old one with `history_base` rather than copying it,
and counts from zero again, so a session's usage is the sum of every rollout
carrying its id. Its conversation is read across them too. Every line has an
`ordinal` counted on across the thread, and a continuation's
`history_base.end_ordinal_exclusive` is the ordinal it picks up from, so what
the earlier rollout wrote from there on was abandoned, as by a rewind. A later
rollout with no base shares nothing with the one before and starts the
conversation over. Keeping one file's last total instead undercounted Codex on
this machine by about a fifth. A spawned run's rollout carries its parent's
`session_meta` after its own, so the first one identifies it. Codex counts
cached input inside `input_tokens`, which Overwatch separates. Reasoning content
is encrypted and is never deserialized; only the readable summary reaches a
transcript. Codex records **no tool failure
signal**: every one of the 29,152 tool outputs in the reference corpus has
`status: null`, and `exit_code` appears in twenty of them, so a tool call from
Codex never shows a "Failed" badge and its output is left to speak for itself.

**OpenCode** records each assistant message's time, model, tokens and cost in
`session_message`, so usage is counted per message and priced under its
`providerID`. OpenCode's own cost, which is zero for usage a subscription paid
for, stands in only for a model the catalog does not list. It counts reasoning
separately from output, so unlike Claude Code reasoning _is_ added to the
total. New messages reach SQLite's write-ahead log, `opencode.db-wal`, before
the database file, so a change to either one counts as a change.

**Pi** records usage per message rather than cumulatively, and records which
model and provider were in force, so tokens are attributed per model exactly
and priced under that provider, with Pi's own cost standing in only for a model
the catalog does not list. Reasoning is counted inside `output`. Image
blocks become an `[image]` marker instead of megabytes of base64. Note that a
tool _result_ in Pi is a message with its own `toolResult` role carrying a
`toolCallId`, not a block inside another message — reading it as a block finds
nothing at all.

**Grok** answers a turn's tool calls in whatever order they finish rather than
the order it made them, so results must be matched by `tool_call_id`; pairing
them by position silently puts each output under the wrong call. Its
`updates.jsonl` records each finished turn's usage per model, with what xAI
charged in `costUsdTicks`, ten-billionths of a dollar. That charge is the turn's
cost, because the catalog does not list Grok's build model and a turn of many
requests could not be priced in the right context tier. Cached input is counted
inside `inputTokens` and reasoning inside `outputTokens`. The `totalTokens` on
other updates is the size of the context, not usage; counting it undercounted
Grok on this machine more than twentyfold. Sessions without the file record
usage nowhere, and report none.

## Adding an agent

1. Add a variant to `Agent` in `session.rs` and its key in `Agent::key`.
2. Add its directory to `source::present`.
3. Write `src-tauri/src/source/<agent>.rs` with `discover`, `summarize`, and
   `transcript`, and wire it into the three `match` statements in
   `source/mod.rs`.
4. Add its display name, mark, chart colour and resume command to
   `src/lib/agents.ts`, and the colour itself to `src/app.css`.
5. If it can hold a subscription's sign-in, add a `Source` for it to that
   subscription's reader in `src-tauri/src/account/`.

`summarize` counts each usage record into a `Tally` at the instant it happened,
under the model that produced it, after undoing whatever the format does —
repeated records, running totals, out-of-order writes. Cover the arithmetic
with tests whose expected values are established independently, not by
round-tripping through the same code.
