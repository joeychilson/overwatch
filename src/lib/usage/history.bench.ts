/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { bench, describe } from "vite-plus/test";
import type { Session } from "../bindings";
type Snapshot = { sessions: Session[] };
import { parseCatalog } from "../models/catalog";
import { aggregate } from "./analytics";

const directory = process.env.OVERWATCH_BENCH_DIR;
if (!directory)
  throw new Error("Run via `vp run benchmark` to generate the native fixtures first.");
const catalogJson = readFileSync(new URL("../../../public/catalog.json", import.meta.url), "utf8");
const models = parseCatalog({
  benchmark: {
    name: "Benchmark",
    models: Object.fromEntries(
      ["alpha", "beta"].map((id) => [
        id,
        {
          id,
          name: id,
          cost: { input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 },
        },
      ]),
    ),
  },
});
const options = { time: 1000, warmupTime: 250, iterations: 10 };
// Fixed UTC windows, independent of when the benchmark is run.
const end = Date.UTC(2026, 0, 1);
const start = end - 30 * 86_400_000;

for (const [name, expectedSessions, expectedUsage] of [
  ["small", 100, 1990],
  ["large", 5000, 224960],
] as const) {
  const json = readFileSync(join(directory, `${name}-snapshot.json`), "utf8");
  const snapshot: Snapshot = JSON.parse(json);
  const stats = aggregate(snapshot.sessions, models);
  if (
    snapshot.sessions.length !== expectedSessions ||
    stats.calls !== expectedUsage ||
    stats.total !== expectedUsage * 180
  ) {
    throw new Error(
      `Invalid ${name} benchmark fixture; refusing to time missing or incomplete data.`,
    );
  }
  if (!aggregate(snapshot.sessions, models, start, end).calls) {
    throw new Error(`The ${name} date-scoped workload must include usage.`);
  }
  describe(name, () => {
    bench("snapshot JSON parse", () => JSON.parse(json), options);
    bench(
      "lifetime usage aggregate",
      () => {
        aggregate(snapshot.sessions, models);
      },
      options,
    );
    bench(
      "30-day usage aggregate",
      () => {
        aggregate(snapshot.sessions, models, start, end);
      },
      options,
    );
    bench(
      "overview aggregates (current + lifetime + previous)",
      () => {
        aggregate(snapshot.sessions, models, start, end);
        aggregate(snapshot.sessions, models);
        aggregate(snapshot.sessions, models, start - 30 * 86_400_000, start);
      },
      options,
    );
  });
}

bench(
  "bundled catalog JSON parse + validation + model mapping",
  () => {
    parseCatalog(JSON.parse(catalogJson));
  },
  options,
);
