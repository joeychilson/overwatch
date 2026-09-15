# Project conventions

## Runtime

- This is a SvelteKit static frontend bundled in Tauri, with SSR disabled. Native operations use Tauri commands. Do not add runtime server routes or remote functions that require a JavaScript server.
- Use the installed versions and their current official documentation when introducing unfamiliar APIs. This project uses [SvelteKit 3 prereleases](https://next.svelte.dev/docs/kit) and [Svelte async rendering](https://svelte.dev/docs/svelte/await-expressions).
- The content security policy allows no external origins. Network requests belong in Rust, not the webview. Adding an origin to `tauri.conf.json` is an architectural change, not a convenience.

## Rust

- Name modules for stable responsibilities, such as `session.rs` or `price.rs`. Do not create files for individual functions, patches, or implementation steps, and do not add `util.rs`, `utils.rs`, or `helpers.rs`.
- Keep unit tests in one inline `#[cfg(test)] mod tests` at the bottom of the file they test, after every production item, with their imports and fixtures inside that module. Integration tests exercise public APIs from `src-tauri/tests/` in files named for the behavior they cover. Do not create `tests.rs`, `test.rs`, `*_test.rs`, or `*_tests.rs`.
- Parsing tests need independently established expected values. A round trip through the same code can hide a matching pair of encoding and decoding bugs.
- Untrusted input produces typed errors rather than panics. Validate lengths and bounds before allocating or mutating, and reserve `expect` for documented internal invariants. Use explicit checked or wrapping arithmetic according to the contract, and avoid unchecked narrowing conversions, ignored errors, and success-shaped fallbacks for invalid data.
- Prefer concrete types and ordinary control flow. Introduce traits, generics, builders, and macros for demonstrated consumers. Keep items `pub(crate)` unless the bridge or another module needs wider access, and use domain types where they prevent identity, unit, or lifetime mistakes.
- Document public items with their contracts, bounds, errors, and non-obvious behavior. Comments explain why or record an invariant; they do not narrate syntax or development history.
- Warnings are errors. Do not silence a lint, relax the crate's safety and lint policy, or weaken a check to make work pass; a necessary exception is a decision to raise, not a local edit.

## Svelte

- Use Svelte 5 runes, `$props`, event attributes, and snippets. Avoid legacy component syntax and React-style hooks or memoization patterns in new code.
- Keep simple state local and pure transformations in functions. Use classes with `$state` fields in `.svelte.ts` when reusable state has behavior or a lifecycle. Give each instance a clear owner and clean up its listeners and subscriptions.
- Encapsulate state when changes must also persist or perform external work. Use callback-safe methods and serialize explicit data records. Read reactive class fields through their instance; ordinary destructuring loses those reactive reads.
- Derive calculated values with `$derived` or computed getters. Put user-triggered work in handlers or methods. Use lifecycle hooks for setup and cleanup, and `$effect` when external synchronization requires it; do not mirror reactive state through effects.
- A method that both reads and writes its own `$state` must untrack that work, or an effect calling it depends on the fields it just changed and re-runs forever. Keep the untracking inside the state class so every call site is safe.
- Read data with `await` inside a `<svelte:boundary>`, not by firing a request from an effect. The boundary's `pending` snippet covers the first load, `$effect.pending()` covers later ones, `failed` receives the error with a `reset`, and Svelte discards a result superseded by a newer one. Put the `await` in the boundary's own content so that boundary owns it; an `await` in a component's script suspends the component and belongs to its parent's boundary.
- Own a read explicitly only when a superseded result must still be released, such as a frozen session view the engine holds against a budget, or when pages accumulate rather than replace. Say which in a comment. Everything else derives.
- Define initial loading, subsequent pending updates, and recoverable errors for each asynchronous feature. Verify behavior when inputs change before earlier work finishes.

## Styling and desktop UI

- Use Tailwind utilities for ordinary styling and scoped component CSS when clearer. Style third-party components through their supported APIs, including portalled content.
- Keep `src/app.css` for Tailwind setup, fonts, shared semantic theme tokens, and essential document defaults. Put overridable defaults in `@layer base`.
- Retain native macOS window controls and the overlay title bar. Keep drag regions outside scrollable content and interactive controls outside drag regions. Preserve keyboard access, visible focus, and a skip link clear of native controls.
- Use direct imports from `@lucide/svelte/icons/...` for standard icons; custom SVGs are for application-specific artwork.

## Organization

- Use PascalCase component filenames and names. Keep SvelteKit reserved filenames unchanged. Use lowercase kebab-case for folders and ordinary TypeScript modules; rune modules end in `.svelte.ts`.
- Put reusable components in `src/lib/components/`. Group related feature components in shallow feature folders when needed. Use `components/ui/` only for shared primitives required by current features.
- Keep reusable reactive state in `src/lib/state/` and routes in `src/routes/`. Prefer direct component imports. Add abstractions and folders when current code benefits, rather than scaffolding future features.
- Import across folders through the `#lib/*` subpath and name the file's real extension, as in `#lib/state/engine.svelte.ts`. SvelteKit 3 defines no `$lib` path mapping, and a subpath import performs no extension resolution, so an extensionless specifier does not resolve. Use relative paths only within a folder.

## Verification

- Use the project-local Vite+ CLI as documented in README. For frontend behavior, run `vp exec vp run check` and `vp exec vp run test`, which runs the unit tests before the browser suite. Unit tests sit beside the module they cover as `*.test.ts` and import from `vite-plus/test`; `tests/` holds only the Playwright suite. Run `vp exec vp run check:rust` when Rust or native dependencies change.
- Verify the production desktop build for changes affecting native behavior, packaging, runtime configuration, or dependencies. Inspect native window behavior in the packaged app; browser tests do not establish it.
- Tests should protect user behavior and meaningful failure cases. Cover arithmetic and external-format parsing with Rust tests close to the code that performs them. Use regression coverage for identified bugs. Do not weaken assertions to make a failure disappear or add tests that merely repeat implementation details.

## Commits

- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for commit subjects: `type(scope): description`. Scope is optional for changes that span the project.
- Types: `feat` adds a capability; `fix` corrects behavior; `perf` improves measured performance; `refactor` changes structure without changing behavior; `docs`, `test`, `build`, `ci`, and `style` cover their respective concerns; `chore` covers other maintenance. Choose the primary purpose of the change.
- Use a stable scope naming an area rather than a file path or function, such as `sessions`, `usage`, `ui`, or `native`. Use `repo` or `deps` for shared concerns. Scopes use lowercase letters, digits, and hyphens.
- Keep the complete subject at most 72 characters. Start the description with a lowercase imperative verb, omit the final period, and describe the actual result. Examples: `feat(usage): add daily cost rollups`, `fix(sessions): handle truncated history lines`.
- Make each commit coherent and buildable, keeping implementation together with its tests. Keep unrelated cleanup out of feature and fix commits, and use the body for motivation and non-obvious decisions the subject cannot carry.
- Mark an incompatible command signature, cache schema, or stored setting with `!` before the colon and a `BREAKING CHANGE:` footer explaining the impact. Include measurements for `perf` claims.
