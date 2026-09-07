# macOS releases and updates

The release workflow produces an Apple Silicon macOS app, notarizes it, and creates a **draft** GitHub release with signed updater artifacts. It accepts stable tags only (`vMAJOR.MINOR.PATCH`). It fails before building when signing credentials are missing; it never falls back to unsigned distribution.

## One-time configuration

Create a protected GitHub environment named `release`. Configure these secrets in that environment (or repository secrets accessible to it):

| Secret                               | Value                                                                                               |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `APPLE_CERTIFICATE`                  | Base64-encoded Developer ID Application certificate exported as a `.p12`, including its private key |
| `APPLE_CERTIFICATE_PASSWORD`         | Password used when exporting that certificate                                                       |
| `APPLE_SIGNING_IDENTITY`             | Exact `Developer ID Application: Name (TEAMID)` identity                                            |
| `APPLE_ID`                           | Apple Developer account email                                                                       |
| `APPLE_PASSWORD`                     | An Apple app-specific password for notarization                                                     |
| `APPLE_TEAM_ID`                      | Apple Developer team ID                                                                             |
| `TAURI_SIGNING_PRIVATE_KEY`          | Private updater-signing key produced by the Tauri signer                                            |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password, if encrypted                                                                  |

Generate the updater key with `vp run tauri signer generate -w <secure-path-outside-the-repository>`. Back it up securely: existing installations trust its matching public key, so losing the private key breaks their update path. Never commit the private key or put it in the frontend.

Set the GitHub **variable** `TAURI_UPDATER_PUBLIC_KEY` to the public key from that command (the contents of the `.pub` file). The workflow inserts only this public key and the Apple signing identity into a temporary build configuration. No private signing material is embedded in the application.

See the official [macOS signing and notarization guide](https://v2.tauri.app/distribute/sign/macos/) and [updater signing guide](https://v2.tauri.app/plugin/updater/).

## Stable channel

Signed release builds use `https://github.com/joeychilson/overwatch/releases/latest/download/latest.json`. Drafts and prereleases do not become the stable update feed. The native application menu offers **Check for Updates…**; download and installation happen only after choosing **Install and restart**. HTTPS and artifact signature verification remain enabled. Development builds without release configuration disable the menu action.

The workflow checks matching package/Cargo/Tauri/tag versions, runs the regular regression checks, builds with credentials, uploads signed updater metadata, and verifies the application with `codesign`, `stapler`, and Gatekeeper. The resulting release stays a draft for review.

## Before publishing the first release

These are required verification steps, not claims that local development tests have completed them:

1. Download the draft DMG on macOS, install it, and confirm Gatekeeper accepts the signed, notarized app without a security bypass.
2. Confirm local histories, source settings, saved workspace state, and costs behave correctly on that installed build.
3. Install a previous build signed with the same updater key. Publish the reviewed newer stable release and use Check for Updates to upgrade; verify version, source settings, history migration, and reading position after restart.
4. Verify offline checks report an error without affecting the installed app, cancellation leaves it unchanged, and a deliberately invalid artifact signature is rejected in a controlled test release.

Apple credentials and updater keys are not configured yet. Signed installation and upgrade verification remain an outstanding release gate. Do not publish externally until these checks are complete.
