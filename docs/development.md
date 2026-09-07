# Development

See the [README](../README.md#run-locally) for prerequisites and local setup. Run the commands below from the repository root.

## Checks and tests

```sh
vp check
vp test run
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
vp exec playwright install chromium webkit
vp exec playwright test
```

CI also checks generated bindings and builds the desktop app. Browser tests use a mocked native bridge; Rust tests exercise parsing and indexing in temporary directories. Provider authentication, Keychain prompts, and native dialogs need manual desktop testing. Keep fixtures synthetic and exclude credentials and session exports from commits.

For performance measurements, run `vp run benchmark`. The [benchmark guide](benchmarks.md) covers workloads and comparing results across revisions.

## Source layout

- `src/pages` and `src/lib`: React UI and frontend logic, with unit tests beside their modules.
- `src/lib/usage` and `src/lib/models`: usage calculations, charts, forecasts, model identity, and catalog validation.
- `src-tauri/src`: native indexing, source adapters, and account operations.
- `src-tauri/tests` and `tests`: native integration tests and browser tests.

## Native bindings and cached data

After changing native commands or types, regenerate `src/lib/bindings.ts`:

```sh
cargo run --manifest-path src-tauri/Cargo.toml --locked --bin bindings
```

When changing normalized session data, increment `parse::VERSION` in `src-tauri/src/parse/mod.rs`. Scanning rebuilds outdated summaries from their original histories; unavailable sources retain cached summaries. Legacy `settings.json` preferences are imported into SQLite once.

## Releases

The release workflow accepts stable `vMAJOR.MINOR.PATCH` tags matching the versions in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. It runs checks and creates a draft Apple Silicon release with an app, DMG, and signed updater artifacts.

The [release guide](releases.md) covers required signing credentials, notarization, and installation checks before publishing.
