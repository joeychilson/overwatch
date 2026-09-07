import { test } from "node:test";
import assert from "node:assert/strict";
import { releaseConfig } from "./prepare-release.mjs";
const env = {
  APPLE_CERTIFICATE: "fixture-private-certificate",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Fixture (TEAM123456)",
  APPLE_ID: "fixture@example.test",
  APPLE_PASSWORD: "fixture-private-password",
  APPLE_TEAM_ID: "TEAM123456",
  TAURI_SIGNING_PRIVATE_KEY: "fixture-private-updater-key",
  TAURI_UPDATER_PUBLIC_KEY: Buffer.from(
    `untrusted comment: fixture public key\n${Buffer.alloc(42).toString("base64")}\n`,
  ).toString("base64"),
};
test("missing credentials and ad-hoc identities cannot produce release configuration", () => {
  for (const name of Object.keys(env))
    assert.throws(() => releaseConfig({ ...env, [name]: "" }), /missing/);
  assert.throws(() => releaseConfig({ ...env, APPLE_SIGNING_IDENTITY: "-" }), /Developer ID/);
  assert.throws(
    () => releaseConfig({ ...env, TAURI_UPDATER_PUBLIC_KEY: "placeholder" }),
    /public key/,
  );
});
test("only the public verification key and signing identity enter stable configuration", () => {
  const config = releaseConfig(env);
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/joeychilson/overwatch/releases/latest/download/latest.json",
  ]);
  assert.equal(config.plugins.updater.pubkey, env.TAURI_UPDATER_PUBLIC_KEY);
  assert.doesNotMatch(JSON.stringify(config), /fixture-private/);
  assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol, undefined);
});
