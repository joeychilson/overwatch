import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, release, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(join(tmpdir(), "overwatch-benchmark-"));
const env = { ...process.env, TZ: "UTC", OVERWATCH_BENCH_DIR: output };

function command(program, args, capture = false) {
  const result = spawnSync(program, args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${program} ${args.join(" ")} failed: ${result.stderr ?? result.status}`);
  return result.stdout?.trim();
}

console.log(`Benchmark results: ${output}`);
try {
  const metadata = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    revision: command("git", ["rev-parse", "HEAD"], true),
    dirty: !!command("git", ["status", "--porcelain"], true),
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    node: process.version,
    rust: command("rustc", ["--version"], true),
    timezone: env.TZ,
  };
  writeFileSync(join(output, "environment.json"), JSON.stringify(metadata, null, 2));
  command("cargo", [
    "bench",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--bench",
    "history",
  ]);
  command("vp", [
    "test",
    "bench",
    "--run",
    "src/lib/usage/history.bench.ts",
    "--outputJson",
    join(output, "frontend.json"),
  ]);
  // The snapshots can be large. Keep the compact results, not the generated data.
  for (const { name } of JSON.parse(readFileSync(join(output, "native.json"), "utf8")).workloads) {
    rmSync(join(output, `${name}-snapshot.json`));
  }
  console.log(`Results saved to ${output}`);
} catch (error) {
  console.error(error);
  console.error(`Partial results retained at ${output}`);
  process.exitCode = 1;
}
