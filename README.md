# overwatch

[![CI](https://github.com/joeychilson/overwatch/actions/workflows/ci.yml/badge.svg)](https://github.com/joeychilson/overwatch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

A desktop app for exploring coding-agent sessions, token usage, model costs, and subscription allowances. Histories stay on your machine.

| Overview                                                                                                         | Sessions                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| [![Overview showing activity, token usage, and costs](.github/images/overview.png)](.github/images/overview.png) | [![Sessions showing searchable local conversation history](.github/images/session-list.png)](.github/images/session-list.png) |

| Session detail                                                                                                          | Models                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [![Session detail showing metrics, timeline, and transcript](.github/images/sessions.png)](.github/images/sessions.png) | [![Models showing usage across coding agents](.github/images/models.png)](.github/images/models.png) |

| Subscriptions                                                                                                                        | Connections                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [![Subscriptions showing provider allowances and usage history](.github/images/subscriptions.png)](.github/images/subscriptions.png) | [![Connections showing local agent history sources](.github/images/connections.png)](.github/images/connections.png) |

_Sample data. Click any screenshot to view it at full size._

Built for macOS 13.3+ on Apple Silicon. Other platforms are not tested or released.

## Features

- Browse and search local sessions from Codex, Claude Code, OpenCode, Pi, and Grok Build.
- Explore token usage, recorded costs and catalog estimates, model pricing, and tool activity.
- Compare model usage across providers and agents, then open the contributing sessions.
- Track subscription allowances for Codex, Claude, OpenCode Go, Grok, and Antigravity.
- Export usage as CSV and transcripts as JSON.

Model versions and variants stay distinct. Pricing uses each provider's exact offering from a bundled [models.dev](https://models.dev) catalog, with optional refreshes. Missing prices stay unknown; estimates are not subscription bills.

## Local data and accounts

Overwatch reads original histories without modifying them. In Connections, review
the detected source folders and disable any you do not want indexed. Antigravity
supports subscription allowances only; Pi supports session history only.

On macOS, the SQLite database stores settings, session summaries, and allowance history in
`~/Library/Application Support/com.joeychilson.overwatch/history.sqlite`; cached pricing
lives beside it. Existing `settings.json` preferences are imported once. The index includes
session titles, project paths, and usage summaries. Transcripts are read from the
original histories on demand. JSON exports contain normalized transcript events;
individual text and tool-output fields are limited to 60 KB, as in the reader.

Subscription refreshes use an existing provider sign-in or an access token saved
through Subscriptions in the OS credential store. Tokens are not refreshed by
Overwatch; renew expired sign-ins through the provider. Connected accounts refresh
about every five minutes, with longer delays after failures. Provider usage
endpoints can change independently of this app.

Session histories are not uploaded. Network requests are limited to account usage
and manual pricing refreshes; links you open launch in your browser.

## Development

Install [Vite+](https://viteplus.dev), Node.js 26+, stable Rust, and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), then run:

```text
vp install --frozen-lockfile
vp run tauri dev
```

Use `vp dev` for the frontend alone. Reading local histories and connecting accounts require the desktop app.

Run checks and tests with:

```text
vp check
vp test run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
vp exec playwright install chromium webkit
vp exec playwright test
```

CI runs these checks and builds the desktop app. Browser tests use a mocked native
bridge; Rust tests exercise parsing and indexing in temporary directories. Live
provider authentication, Keychain prompts, and native dialogs need manual desktop
testing. Keep test fixtures synthetic and exclude credentials and session exports
from commits.

Run `vp run benchmark` for repeatable small/large synthetic history benchmarks.
See [the benchmark guide](docs/benchmarks.md) for workloads, measurement boundaries,
and comparing results across revisions.

The React frontend lives in `src/pages` and `src/lib`. `src/lib/usage` contains
cost accounting, aggregation, charts, and subscription forecasts; `src/lib/models`
contains catalog validation and model identity. Transcript helpers and the app
shell also have their own folders under `src/lib`. Unit tests sit beside their
modules. Native indexing, source adapters, and account operations live in
`src-tauri/src`; cross-adapter indexing tests live in `src-tauri/tests`.

After changing native commands or types, regenerate `src/lib/bindings.ts`:

```text
cargo run --manifest-path src-tauri/Cargo.toml --locked --bin bindings
```

When changing normalized session data, increment `parse::VERSION` in
`src-tauri/src/parse/mod.rs`. Scanning rebuilds outdated summaries from their
original histories; unavailable sources retain their cached summaries.

## Build

```text
vp run tauri build --bundles app -- --locked
```

The macOS app is written to `src-tauri/target/release/bundle/macos/Overwatch.app`.
Omit `--bundles app` to also build a DMG.

Push a `v`-prefixed version tag (for example, `v0.1.0`) matching `package.json`,
`src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json` to run checks, build the app
and DMG, and create a draft GitHub Release for Apple Silicon.
Signing and notarization are not configured.

## License

[MIT](LICENSE). Model metadata and logo credits are listed in [sources](public/logos/sources.md).
