import { z } from "zod";
import { agentIds } from "@/lib/agents";

const text = z.string().max(4096);
const index = z.number().int().min(0).max(1_000_000_000);
const agent = z.enum(agentIds);
const sort = z.enum(["title", "project", "tokens", "duration", "responses", "updatedAt"]);
const scope = z.object({
  agent: agent.nullable(),
  project: text.nullable(),
  start: z.number().finite().nullable(),
  end: z.number().finite().nullable(),
  offerings: z.array(text).max(10000),
});
const sessionQuery = z.object({
  scope,
  search: text,
  searchModels: z.array(text).max(10000),
  activityAfter: z.number().finite().nullable(),
  activityBefore: z.number().finite().nullable(),
  day: text.nullable(),
  tool: text.nullable(),
  model: text.nullable(),
  failedOnly: z.boolean(),
  usageOnly: z.boolean(),
  offset: index,
  limit: z.number().int().min(1).max(100),
  sort,
  descending: z.boolean(),
});
export const routeSchema = z.discriminatedUnion("view", [
  z.object({ view: z.literal("overview") }),
  z.object({ view: z.literal("connections") }),
  z.object({ view: z.literal("subscriptions") }),
  z.object({
    view: z.literal("models"),
    modelKey: text.optional(),
    pricing: z.boolean().optional(),
    reading: text.optional(),
  }),
  z.object({
    view: z.literal("sessions"),
    id: text.optional(),
    query: sessionQuery.optional(),
    day: text.optional(),
    tool: text.optional(),
    search: text.optional(),
  }),
]);
export type Route = z.infer<typeof routeSchema>;
export const workspaceSchema = z.object({
  version: z.literal(1),
  route: routeSchema,
  agent: z.union([agent, z.literal("all")]),
  project: text,
  range: z.enum(["7", "30", "90", "365"]),
  sessions: z.object({
    search: text,
    range: z.enum(["all", "7", "30", "90"]),
    offset: index,
    sort,
    descending: z.boolean(),
    model: text.nullable(),
    tool: text.nullable(),
    failedOnly: z.boolean(),
    scroll: index,
    focus: text.nullable(),
  }),
  models: z.object({
    search: text,
    ranking: z.enum(["model", "tokens", "share", "cost", "calls"]).nullable().default(null),
    rankingDescending: z.boolean().default(true),
    provider: text,
    agent: z.union([agent, z.literal("all")]),
    offset: index,
    sort,
    descending: z.boolean(),
  }),
  scroll: index,
  readers: z.array(z.object({ id: text, index })).max(20),
});
export type WorkspaceState = z.infer<typeof workspaceSchema>;
export const initialWorkspace: WorkspaceState = {
  version: 1,
  route: { view: "overview" },
  agent: "all",
  project: "all",
  range: "30",
  sessions: {
    search: "",
    range: "all",
    offset: 0,
    sort: "updatedAt",
    descending: true,
    model: null,
    tool: null,
    failedOnly: false,
    scroll: 0,
    focus: null,
  },
  models: {
    search: "",
    ranking: null,
    rankingDescending: true,
    provider: "all",
    agent: "all",
    offset: 0,
    sort: "updatedAt",
    descending: true,
  },
  scroll: 0,
  readers: [],
};
export const workspaceKey = "overwatch.workspace.v1";
export function readWorkspace(value: unknown): WorkspaceState {
  return workspaceSchema.safeParse(value).data ?? structuredClone(initialWorkspace);
}
export function loadWorkspace(): WorkspaceState {
  try {
    return readWorkspace(JSON.parse(localStorage.getItem(workspaceKey) ?? "null"));
  } catch {
    return structuredClone(initialWorkspace);
  }
}
