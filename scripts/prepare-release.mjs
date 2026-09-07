import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function releaseConfig(env) {
  const required = [
    "APPLE_CERTIFICATE",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
    "TAURI_SIGNING_PRIVATE_KEY",
    "TAURI_UPDATER_PUBLIC_KEY",
  ];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Release credentials are missing: ${missing.join(", ")}. See docs/releases.md.`,
    );
  if (!/^Developer ID Application: .+ \([A-Z0-9]+\)$/.test(env.APPLE_SIGNING_IDENTITY))
    throw new Error("A Developer ID Application signing identity is required for distribution.");
  const key = env.TAURI_UPDATER_PUBLIC_KEY.trim();
  const decoded = Buffer.from(key, "base64").toString("utf8").trim().split(/\r?\n/);
  if (
    decoded.length !== 2 ||
    !decoded[0].startsWith("untrusted comment:") ||
    Buffer.from(decoded[1], "base64").length !== 42
  )
    throw new Error(
      "TAURI_UPDATER_PUBLIC_KEY must contain the public key produced by tauri signer generate.",
    );
  return {
    bundle: {
      createUpdaterArtifacts: true,
      macOS: { signingIdentity: env.APPLE_SIGNING_IDENTITY },
    },
    plugins: {
      updater: {
        pubkey: key,
        endpoints: [
          "https://github.com/joeychilson/overwatch/releases/latest/download/latest.json",
        ],
      },
    },
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) throw new Error("Pass the output configuration path.");
  if (!/^v\d+\.\d+\.\d+$/.test(process.env.GITHUB_REF_NAME ?? ""))
    throw new Error("This workflow publishes stable version tags only (vMAJOR.MINOR.PATCH).");
  writeFileSync(process.argv[2], JSON.stringify(releaseConfig(process.env), null, 2) + "\n", {
    mode: 0o600,
  });
}
