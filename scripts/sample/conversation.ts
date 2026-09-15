/**
 * The conversation the featured sample session holds: someone and Claude Code
 * adding idempotency keys to a payments API over an afternoon, with a break in
 * the middle.
 *
 * The opening exchanges are written out, because they are what a screenshot of
 * the session shows. The work after them is assembled from each phase's files
 * and commands, so the timeline and the counts have an afternoon's density.
 */
import type { Mark, Speaker, ToolCall, Turn } from "#lib/api/backend.ts";
import { noise, pick } from "./random.ts";

/** The model the replies came from. */
export const MODEL = "claude-opus-5";
/** Where the session worked. */
export const PROJECT = "/Users/me/Code/ledger-api";

/** A turn before it has a time: what it is, and roughly how many seconds after the one before. */
interface Draft {
  speaker: Speaker;
  after: number;
  text: string;
  tool: ToolCall | null;
}

/** A command, what it printed, and what it printed when it failed. */
type Command = [command: string, description: string, output: string, failure?: string];

/** A stretch of work after the opening: what was asked, what the agent did, and what it said. */
interface Phase {
  ask: string;
  /** Short updates the agent gives along the way. */
  updates: string[];
  reply: string;
  files: string[];
  commands: Command[];
  /** How many steps it takes, thinking included. */
  steps: number;
  /** How many of its commands fail before the fix lands. */
  fails: number;
  /** Steps taken before the rest, such as a subagent sent to look. */
  first?: ToolCall[];
}

function call(name: string, input: Record<string, unknown>, output: string, failed = false) {
  return { name, input: JSON.stringify(input), output, failed } satisfies ToolCall;
}

const inProject = (path: string) => `${PROJECT}/${path}`;

/** Lines as Claude Code's Read prints them, numbered. */
const numbered = (lines: string[]) =>
  lines.map((line, index) => `${String(index + 1).padStart(6)}\t${line}`).join("\n");

const read = (path: string, lines: string[]) =>
  call("Read", { file_path: inProject(path) }, numbered(lines));
const edit = (path: string, before: string, after: string) =>
  call(
    "Edit",
    { file_path: inProject(path), old_string: before, new_string: after },
    `The file ${inProject(path)} has been updated successfully.`,
  );
const write = (path: string, content: string) =>
  call(
    "Write",
    { file_path: inProject(path), content },
    `File created successfully at: ${inProject(path)}`,
  );
const bash = ([command, description, output, failure]: Command, failed = false) =>
  call("Bash", { command, description }, failed && failure ? failure : output, failed);
const grep = (pattern: string, files: string[]) =>
  call(
    "Grep",
    { pattern, path: "src", output_mode: "files_with_matches" },
    `Found ${files.length} files\n${files.join("\n")}`,
  );

const TYPES: Command = [
  "pnpm tsc --noEmit",
  "Type check",
  "",
  "src/middleware/idempotency.ts(41,23): error TS2345: Argument of type 'string | undefined' is not assignable to parameter of type 'string'.",
];
const UNIT: Command = [
  "pnpm vitest run src/middleware/idempotency.test.ts",
  "Run the idempotency tests",
  " ✓ src/middleware/idempotency.test.ts (9 tests) 184ms\n\n Test Files  1 passed (1)\n      Tests  9 passed (9)",
  " FAIL  src/middleware/idempotency.test.ts > replays a retry with the same body\nAssertionError: expected 422 to be 201",
];
const SUITE: Command = [
  "pnpm test",
  "Run the full test suite",
  " Test Files  58 passed (58)\n      Tests  412 passed (412)\n   Duration  41.7s",
  " Test Files  1 failed | 57 passed (58)\n      Tests  1 failed | 411 passed (412)",
];
const POSTGRES: Command = [
  "DATABASE_URL=postgres://localhost:5432/ledger_test pnpm test:integration",
  "Run the integration tests against Postgres",
  " ✓ 20 concurrent retries with one key make one charge (1.9s)\n\n      Tests  31 passed (31)",
  " ✗ 20 concurrent retries with one key make one charge\n   expected 1 charge, received 2",
];
const LINT: Command = ["pnpm lint", "Lint", "✔ No problems found"];

const SOURCE = [
  [
    'import type { Request, Response, NextFunction } from "express";',
    'import { withTransaction } from "../db/store";',
    "",
    "export async function createCharge(req: Request, res: Response) {",
  ],
  [
    'export const idempotencyKeys = pgTable("idempotency_keys", {',
    '  apiKeyId: uuid("api_key_id").notNull(),',
    '  key: text("key").notNull(),',
    '  requestHash: text("request_hash").notNull(),',
  ],
  [
    'describe("idempotency", () => {',
    '  it("replays a retry with the same body", async () => {',
    '    const first = await post("/payments", body, { key: "k-1" });',
  ],
];

const CHANGES: [string, string][] = [
  [
    'const key = req.header("Idempotency-Key");',
    'const key = parseKey(req.header("Idempotency-Key"));',
  ],
  ["await store.insert(record);", "await tx.insert(record).onConflictDoNothing();"],
  [
    "expiresAt: addHours(now, 24),",
    "expiresAt: new Date(now.getTime() + config.idempotencyTtlMs),",
  ],
  ["return res.status(201).json(charge);", "return respond(res, key, 201, charge);"],
];

const PATTERNS = [
  "Idempotency-Key",
  "createCharge\\(",
  "idempotency_keys",
  "expires_at",
  "withTransaction",
];

const THOUGHTS = [
  "The claim and the charge have to commit together, or a crash between them leaves a key that points at nothing.",
  "Check whether the refund route shares the payment route's validation before changing both.",
  "This test passes against the in-memory store for the wrong reason: it never runs two requests at once.",
  "The provider supports idempotency too. Deriving its key from ours makes a retried call safe end to end.",
  "Keep the middleware unaware of routes. It only needs the key, a hash of the body, and the response.",
];

const BEFORE_BREAK: Phase[] = [
  {
    ask: "Run the whole suite, and check the concurrent case against a real Postgres rather than the in-memory store. Two retries racing each other is what actually bit us.",
    updates: [
      "Starting Postgres from the compose file and running the integration suite against it.",
      "The race test fails against Postgres: both requests see the key as missing before either inserts it. The in-memory store ran them one at a time, which hid it.",
      "Switched the claim to `INSERT … ON CONFLICT DO NOTHING RETURNING`, so exactly one request wins the key and the other sees the conflict.",
    ],
    reply:
      "The full suite passes against Postgres: 412 tests, including a new one that fires 20 concurrent retries with one key and checks for exactly one charge.\n\nThe in-memory store had been hiding the race, so the idempotency tests now also run against Postgres in CI.",
    files: [
      "src/middleware/idempotency.ts",
      "src/middleware/idempotency.test.ts",
      "src/db/store.ts",
      "test/setup.ts",
    ],
    commands: [
      [
        "docker compose up -d postgres",
        "Start Postgres",
        " ✔ Container ledger-api-postgres-1  Started",
      ],
      POSTGRES,
      SUITE,
      UNIT,
    ],
    steps: 58,
    fails: 2,
  },
  {
    ask: "Make the 24 hour window configurable per environment.",
    updates: [],
    reply:
      "`IDEMPOTENCY_KEY_TTL` sets it now, defaulting to `24h`, and config validation rejects anything under an hour.",
    files: ["src/config.ts", "src/config.test.ts", "src/middleware/idempotency.ts", ".env.example"],
    commands: [
      TYPES,
      ["pnpm vitest run src/config.test.ts", "Run the config tests", " Tests  14 passed (14)"],
    ],
    steps: 14,
    fails: 0,
  },
  {
    ask: "What happens if the charge goes through but the process dies before we store the response?",
    updates: [
      "Tracing the order of writes in `createCharge` to see what is recorded before the provider answers.",
      "If the process dies between the provider call and the commit, the key stays claimed with no response, and every retry gets 409.",
    ],
    reply:
      "Good catch. That case left the key stuck. Now:\n\n1. The key is claimed as `pending`, and the provider's idempotency key is derived from ours, so a retry can't charge twice at the provider either.\n2. A retry that finds a `pending` key older than 60 seconds sends the charge again with the same provider key, which returns the original charge.\n3. The response is stored once the provider answers.\n\nA new test kills the handler right after the provider call and checks that the retry recovers the original charge.",
    files: [
      "src/services/charges.ts",
      "src/providers/stripe.ts",
      "src/middleware/idempotency.ts",
      "src/services/charges.test.ts",
    ],
    commands: [
      [
        "pnpm vitest run src/services/charges.test.ts",
        "Run the charge tests",
        " Tests  23 passed (23)",
        " FAIL  recovers a charge made before a crash\nAssertionError: expected 2 provider charges to equal 1",
      ],
      TYPES,
      [
        "git diff --stat",
        "Summarize the changes",
        " 11 files changed, 684 insertions(+), 41 deletions(-)",
      ],
    ],
    steps: 48,
    fails: 1,
    first: [
      call(
        "WebFetch",
        {
          url: "https://docs.stripe.com/api/idempotent_requests",
          prompt: "How long are keys kept, and what happens when a retry's parameters differ?",
        },
        "Keys are kept for at least 24 hours. A retry with the same key and different parameters returns an error.",
      ),
    ],
  },
  {
    ask: "Add the header to the OpenAPI spec and the SDK docs, then start the retry load test in the background before I head out for lunch.",
    updates: [
      "Documented `Idempotency-Key` on both operations, with the 409 and 422 responses.",
      "Started `k6 run load/payments-retry.js` in the background. It takes about 30 minutes.",
    ],
    reply:
      "The spec and the SDK guide both describe the header now, including how long keys last and what 409 and 422 mean. The load test is running, and I'll check it when you're back.",
    files: [
      "openapi/payments.yaml",
      "openapi/refunds.yaml",
      "docs/sdk/idempotency.md",
      "load/payments-retry.js",
    ],
    commands: [
      ["pnpm openapi:lint", "Lint the OpenAPI spec", "✔ openapi/ledger.yaml is valid"],
      ["pnpm docs:build", "Build the docs", "✓ built 64 pages in 3.1s"],
      [
        "k6 run load/payments-retry.js",
        "Run the retry load test",
        "Command running in background with ID: b7f2c1",
      ],
    ],
    steps: 34,
    fails: 0,
    first: [
      call(
        "Task",
        {
          description: "Find SDK examples that create payments",
          subagent_type: "Explore",
          prompt:
            "List every example in docs/ and sdk/ that sends POST /payments or POST /refunds, with file and line.",
        },
        "Found 7 examples:\n- docs/sdk/payments.md:42\n- docs/sdk/payments.md:118\n- docs/sdk/refunds.md:31\n- sdk/node/examples/charge.ts:12",
      ),
    ],
  },
];

const AFTER_BREAK: Phase[] = [
  {
    ask: "Back. How did the load test go?",
    updates: [],
    reply:
      "It held up. Over 30 minutes at 400 requests a second, with 15% of requests retried:\n\n- **Duplicate charges:** 37 before, none after\n- **p95 latency:** 212 ms before, 219 ms after\n- **409 responses:** 0.3%, all from retries sent within 50 ms of the first request\n\nThe extra lookup costs about 7 ms at p95.",
    files: ["load/payments-retry.js", "load/results/summary.json"],
    commands: [
      [
        "jq '.metrics' load/results/summary.json",
        "Read the load test summary",
        '{ "http_req_duration": { "p(95)": 219.4 } }',
      ],
    ],
    steps: 10,
    fails: 0,
  },
  {
    ask: "Nice. Now the sweep: use the existing jobs runner and run it at 03:00 UTC. Delete in batches so it doesn't lock the table.",
    updates: [
      "The jobs runner registers schedules in `src/jobs/index.ts`, so the sweep goes next to the invoice reminders.",
      "Deleting 5,000 rows at a time by `expires_at`, using the index the migration already creates.",
    ],
    reply:
      "The sweep runs at 03:00 UTC and deletes expired keys 5,000 rows at a time, pausing 100 ms between batches. A test seeds 12,000 expired keys and 50 live ones and checks that only the live ones survive.",
    files: [
      "src/jobs/index.ts",
      "src/jobs/sweep-idempotency-keys.ts",
      "src/jobs/sweep-idempotency-keys.test.ts",
      "src/db/migrations/0042_idempotency_keys.sql",
    ],
    commands: [
      [
        "pnpm vitest run src/jobs",
        "Run the job tests",
        " Tests  37 passed (37)",
        " FAIL  sweeps expired keys in batches\nError: canceling statement due to lock timeout",
      ],
      TYPES,
      LINT,
    ],
    steps: 44,
    fails: 1,
  },
  {
    ask: "Should refunds share the key space with payments?",
    updates: [],
    reply:
      "No. Keys are scoped by API key and route, so one key sent to `/payments` and `/refunds` names two different requests. That matches how Stripe scopes them, and the SDK guide now says so.",
    files: ["src/middleware/idempotency.ts", "docs/sdk/idempotency.md"],
    commands: [UNIT],
    steps: 10,
    fails: 0,
  },
  {
    ask: "Run everything once more, then open a PR against main with a short summary of the design.",
    updates: [
      "Lint, types and the full suite all pass.",
      "Pushed `feat/idempotency-keys`. Opening the pull request.",
    ],
    reply:
      "Opened **#318 Add idempotency keys to payments and refunds**.\n\nThe description covers the table, how a key is claimed together with the charge, recovery after a crash, and the load test numbers. CI is running.",
    files: ["CHANGELOG.md", "src/middleware/idempotency.ts"],
    commands: [
      LINT,
      TYPES,
      SUITE,
      [
        "git push -u origin feat/idempotency-keys",
        "Push the branch",
        "branch 'feat/idempotency-keys' set up to track 'origin/feat/idempotency-keys'.",
      ],
      [
        'gh pr create --base main --title "Add idempotency keys to payments and refunds"',
        "Open the pull request",
        "https://github.com/acme/ledger-api/pull/318",
      ],
    ],
    steps: 30,
    fails: 0,
  },
  {
    ask: "CI flagged the migration as missing a down step.",
    updates: [],
    reply:
      "Added the down migration, which drops the table and its index, and pushed. CI is green.",
    files: ["src/db/migrations/0042_idempotency_keys.sql"],
    commands: [
      [
        "pnpm db:migrate:down --to 0041",
        "Roll back to the previous migration",
        "↓ 0042_idempotency_keys",
      ],
      ["pnpm db:migrate", "Apply migrations", "↑ 0042_idempotency_keys"],
      ["gh pr checks 318", "Check CI", "✓ test  ✓ lint  ✓ migrations"],
    ],
    steps: 16,
    fails: 0,
  },
];

/** The afternoon as stretches of drafts, split where the break was. */
function afternoon(): Draft[][] {
  const stretches: Draft[][] = [];
  let current: Draft[] = [];
  let seed = 0;
  const wait = (least: number, spread: number) => least + noise(++seed) * spread;
  const push = (speaker: Speaker, after: number, text: string, tool: ToolCall | null = null) =>
    current.push({ speaker, after, text, tool });
  const say = (text: string) => push("user", wait(120, 360), text);
  const reply = (text: string) => push("assistant", wait(12, 30), text);
  const think = (text: string) => push("reasoning", wait(4, 10), text);
  const run = (tool: ToolCall) =>
    push("tool", tool.name === "Bash" ? wait(6, 40) : wait(2, 8), "", tool);

  function work(phase: Phase) {
    say(phase.ask);
    phase.first?.forEach(run);
    const chunk = phase.steps / (phase.updates.length + 1);
    const updates = new Map(
      phase.updates.map((text, order) => [Math.round((order + 1) * chunk), text]),
    );
    let fails = phase.fails;
    for (let step = 1; step <= phase.steps; step += 1) {
      const roll = noise(++seed);
      const file = pick(phase.files, ++seed);
      if (roll < 0.14) think(pick(THOUGHTS, ++seed));
      else if (roll < 0.45) run(read(file, pick(SOURCE, ++seed)));
      else if (roll < 0.68) run(edit(file, ...pick(CHANGES, ++seed)));
      else if (roll < 0.9) {
        const command = pick(phase.commands, ++seed);
        const failed = fails > 0 && command[3] !== undefined;
        if (failed) fails -= 1;
        run(bash(command, failed));
      } else run(grep(pick(PATTERNS, ++seed), phase.files.slice(0, 1 + (step % 3))));
      const update = updates.get(step);
      if (update) reply(update);
    }
    reply(phase.reply);
  }

  say(
    "Clients retry `POST /payments` when a request times out, and we've had two double charges this month. Add idempotency keys to the payment endpoints:\n\n- Accept an `Idempotency-Key` header on `POST /payments` and `POST /refunds`\n- Replay the stored response when a key comes back with the same body, and return 422 when the body differs\n- Keep keys for 24 hours\n\nLook at how the webhook handler dedupes events first. I think we can reuse its table.",
  );
  think(
    "The webhook handler already dedupes Stripe events. See what it stores before deciding whether a new table is needed.",
  );
  run(
    grep("processed_events|dedupe", [
      "src/webhooks/stripe.ts",
      "src/db/schema.ts",
      "src/jobs/prune-events.ts",
    ]),
  );
  run(
    read("src/webhooks/stripe.ts", [
      "export async function handleEvent(event: Stripe.Event) {",
      "  if (await seen(event.id)) return;",
    ]),
  );
  run(
    read("src/db/schema.ts", [
      'export const processedEvents = pgTable("processed_events", {',
      '  eventId: text("event_id").primaryKey(),',
    ]),
  );
  run(
    call(
      "Glob",
      { pattern: "src/routes/**/*.ts" },
      "src/routes/customers.ts\nsrc/routes/payments.ts\nsrc/routes/refunds.ts\nsrc/routes/webhooks.ts",
    ),
  );
  run(read("src/routes/payments.ts", SOURCE[0] ?? []));
  run(
    read("src/routes/refunds.ts", [
      'router.post("/refunds", validate(refundSchema), createRefund);',
    ]),
  );
  run(
    bash([
      "git log --oneline -4 -- src/webhooks",
      "Show recent webhook changes",
      "a41c9e2 Retry webhook delivery with backoff\n7d02b18 Dedupe Stripe events by id",
    ]),
  );
  reply(
    "The webhook dedupe won't stretch to this. `processed_events` only stores the event id, and a replay needs the status and body we sent. I'd add a table of its own:\n\n- **`idempotency_keys`**, keyed by account and key, holding a hash of the request body, the response status and body, and `expires_at`\n- **A middleware** that claims the key in the same transaction as the charge, so two concurrent retries can't both get through\n- **A nightly sweep** in the existing jobs runner that deletes expired keys\n\nA retry that arrives while the first request is still running gets `409 Conflict` rather than waiting. Does that sound right?",
  );
  say(
    "Yes. Scope keys per API key rather than per account, since one account can have several integrations.",
  );
  run(
    call(
      "TodoWrite",
      {
        todos: [
          "Add the idempotency_keys migration",
          "Write the middleware",
          "Wire up payments and refunds",
          "Test replays and conflicts",
        ].map((content, order) => ({ content, status: order === 0 ? "in_progress" : "pending" })),
      },
      "Todos have been modified successfully.",
    ),
  );
  run(
    bash([
      "ls src/db/migrations | tail -3",
      "List the latest migrations",
      "0039_invoice_reminders.sql\n0040_customer_tax_ids.sql\n0041_webhook_backoff.sql",
    ]),
  );
  run(
    write(
      "src/db/migrations/0042_idempotency_keys.sql",
      "CREATE TABLE idempotency_keys (\n  api_key_id uuid NOT NULL,\n  key text NOT NULL,\n  request_hash text NOT NULL,\n  status smallint,\n  body jsonb,\n  expires_at timestamptz NOT NULL,\n  PRIMARY KEY (api_key_id, key)\n);",
    ),
  );
  run(
    edit(
      "src/db/schema.ts",
      "export const processedEvents",
      'export const idempotencyKeys = pgTable("idempotency_keys", {',
    ),
  );
  run(
    write(
      "src/middleware/idempotency.ts",
      "export function idempotency(store: KeyStore) {\n  return async (req, res, next) => {",
    ),
  );
  run(
    edit(
      "src/routes/payments.ts",
      'router.post("/payments", validate(paymentSchema), createCharge);',
      'router.post("/payments", validate(paymentSchema), idempotency(keys), createCharge);',
    ),
  );
  run(
    edit(
      "src/routes/refunds.ts",
      'router.post("/refunds", validate(refundSchema), createRefund);',
      'router.post("/refunds", validate(refundSchema), idempotency(keys), createRefund);',
    ),
  );
  run(bash(TYPES, true));
  run(
    edit(
      "src/middleware/idempotency.ts",
      'const key = req.header("Idempotency-Key");',
      'const key = req.header("Idempotency-Key");\n    if (key === undefined) return next();',
    ),
  );
  run(bash(TYPES));
  run(write("src/middleware/idempotency.test.ts", 'describe("idempotency", () => {'));
  run(bash(UNIT, true));
  think(
    "The hash is taken over JSON.stringify of the parsed body, so the same fields in another order hash differently.",
  );
  run(
    edit(
      "src/middleware/idempotency.ts",
      "hash(JSON.stringify(req.body))",
      "hash(canonical(req.body))",
    ),
  );
  run(bash(UNIT));
  reply(
    'The migration and the middleware are in. `POST /payments` and `POST /refunds` both take the header, and the tests cover a replay, a changed body, and a retry that arrives mid-request.\n\nTwo tests failed at first because the body hash depended on key order: `{"amount":500,"currency":"usd"}` and the same fields reordered counted as different requests. Bodies are canonicalized before hashing now.',
  );

  BEFORE_BREAK.slice(0, 3).forEach(work);
  say("/compact");
  push(
    "system",
    20,
    "<local-command-stdout>Compacted. The conversation so far is summarized for the model.</local-command-stdout>",
  );
  BEFORE_BREAK.slice(3).forEach(work);
  stretches.push(current);

  current = [];
  push(
    "system",
    0,
    '<task-notification>\n<task-id>b7f2c1</task-id>\n<status>completed</status>\n<summary>Background command "k6 run load/payments-retry.js" completed (exit code 0)</summary>\n</task-notification>',
  );
  AFTER_BREAK.forEach(work);
  stretches.push(current);
  return stretches;
}

/**
 * The conversation, with each stretch of work spread across its span of Unix
 * milliseconds. There are two stretches, split by a break.
 */
export function conversation(spans: readonly (readonly [start: number, end: number])[]): Turn[] {
  const turns: Turn[] = [];
  for (const [order, drafts] of afternoon().entries()) {
    const span = spans[order];
    if (span === undefined) throw new Error(`No span given for stretch ${order + 1}`);
    const [start, end] = span;
    const total = drafts.slice(1).reduce((sum, draft) => sum + draft.after, 0);
    let elapsed = 0;
    for (const [position, draft] of drafts.entries()) {
      if (position > 0) elapsed += draft.after;
      turns.push({
        index: turns.length,
        speaker: draft.speaker,
        at: Math.round(start + (elapsed / total) * (end - start)),
        model: draft.speaker === "assistant" ? MODEL : null,
        text: draft.text,
        tool: draft.tool,
      });
    }
  }
  return turns;
}

/** Where each turn falls, as the engine's timeline reports it. */
export function marks(turns: readonly Turn[]): Mark[] {
  return turns.map((turn) => ({
    index: turn.index,
    at: turn.at,
    speaker: turn.speaker,
    label: turn.tool?.name ?? (turn.speaker === "reasoning" ? "" : turn.text.slice(0, 120)),
    failed: turn.tool?.failed ?? false,
  }));
}
