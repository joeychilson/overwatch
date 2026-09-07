import type {
  Snapshot,
  HistoryScope,
  SessionQuery,
  Session,
  UsageReport,
  ToolStats,
} from "../src/lib/bindings";
import { aggregate, emptyTokens, toolStats, totalTokens } from "../src/lib/usage/analytics";
import { parseCatalog } from "../src/lib/models/catalog";
import { day, elapsed } from "../src/lib/format";
import { csv } from "../src/lib/export";
import { agents } from "../src/lib/agents";

// The existing pure analytics implementation remains the browser fixture's oracle.
// Native integration tests independently cover SQL behavior on actual SQLite rows.
export function historyFixture(
  command: string,
  args: Record<string, unknown>,
  snapshot: Snapshot,
  catalog: unknown,
) {
  const sessions = snapshot.sessions.filter((session) =>
    snapshot.sources.some(
      (source) => source.source.enabled && source.source.agent === session.agent,
    ),
  );
  const scope = args.scope as HistoryScope;
  const scoped = (scope: HistoryScope) =>
    sessions.filter(
      (session) =>
        (!scope.agent || scope.agent === session.agent) &&
        (!scope.project || scope.project === session.cwd),
    );
  const usage = (session: Session, scope: HistoryScope) =>
    session.usage.filter(
      (point) =>
        (scope.start == null || point.timestamp >= scope.start) &&
        (scope.end == null || point.timestamp < scope.end) &&
        (!scope.offerings.length || scope.offerings.includes(`${point.provider}/${point.model}`)),
    );
  if (command === "get_history_status" || command === "refresh_history")
    return {
      sources: snapshot.sources,
      scanning: snapshot.scanning,
      sessionCount: sessions.length,
      projects: [...new Map(sessions.map((session) => [session.cwd, session.project])).entries()]
        .filter(([path]) => path)
        .sort((a, b) => a[1].localeCompare(b[1])),
      longestSession: sessions.reduce<number | null>((max, session) => {
        const value = elapsed(session.startedAt, session.updatedAt);
        return value == null ? max : Math.max(max ?? 0, value);
      }, null),
      offerings: [
        ...new Set(
          sessions.flatMap((session) =>
            session.usage.map((point) => `${point.provider}/${point.model}`),
          ),
        ),
      ],
    };
  if (command === "get_usage") {
    const selected = scoped(scope).map((session) => ({
      ...session,
      usage: session.usage.filter(
        (point) =>
          !scope.offerings.length || scope.offerings.includes(`${point.provider}/${point.model}`),
      ),
    }));
    const stats = aggregate(
      selected,
      parseCatalog(catalog),
      scope.start ?? 0,
      scope.end ?? Infinity,
    );
    const matched = selected.filter((session) => stats.sessionIds.includes(session.id));
    const report: UsageReport = {
      totals: stats,
      days: [...stats.days.values()].map((point) => ({
        day: point.day,
        totals: {
          ...stats,
          ...point,
          tokens: emptyTokens(),
          calls: point.pricedCalls + point.unpricedCalls,
        },
        agents: point.agents,
        agentCosts: point.agentCosts,
        agentPricedCalls: point.agentPricedCalls,
        models: point.models,
      })),
      models: stats.models.map((model) => ({
        provider: model.provider,
        model: model.model,
        totals: { ...stats, ...model, total: model.tokens, tokens: emptyTokens(), unpriced: 0 },
      })),
      sessionCount: matched.length,
      projectCount: new Set(matched.map((session) => session.cwd).filter(Boolean)).size,
      agentCount: new Set(matched.map((session) => session.agent)).size,
      longestSession: selected.reduce<number | null>((max, session) => {
        const value = elapsed(session.startedAt, session.updatedAt);
        return value == null ? max : Math.max(max ?? 0, value);
      }, null),
    };
    return report;
  }
  if (command === "get_tool_stats")
    return toolStats(
      scoped(scope).filter(
        (session) =>
          (scope.start == null || session.updatedAt >= scope.start) &&
          (scope.end == null || session.updatedAt < scope.end),
      ),
    ) satisfies ToolStats[];
  if (command === "get_log_allowances") return sessions.flatMap((session) => session.limits);
  const query = args.query as SessionQuery;
  const lower = query.search.toLowerCase();
  const rows = scoped(query.scope).filter(
    (session) =>
      (!query.activityAfter || session.updatedAt >= query.activityAfter) &&
      (!query.activityBefore || session.updatedAt < query.activityBefore) &&
      (!query.day ||
        day(session.startedAt) === query.day ||
        session.usage.some((point) => day(point.timestamp) === query.day)) &&
      (!query.tool || session.tools.some((tool) => tool.name === query.tool)) &&
      (!query.failedOnly ||
        session.tools.some((tool) => tool.failures && (!query.tool || tool.name === query.tool))) &&
      (!query.model || session.usage.some((point) => point.model === query.model)) &&
      (!query.usageOnly || usage(session, query.scope).length) &&
      (!lower ||
        `${session.title} ${session.cwd} ${session.model}`.toLowerCase().includes(lower) ||
        query.searchModels.includes(session.model)),
  );
  const value = (session: Session) =>
    query.sort === "tokens"
      ? query.usageOnly
        ? usage(session, query.scope).reduce((sum, point) => sum + totalTokens(point.tokens), 0)
        : totalTokens(session.tokens)
      : query.sort === "responses"
        ? usage(session, query.scope).length
        : query.sort === "duration"
          ? elapsed(session.startedAt, session.updatedAt)
          : session[query.sort];
  rows.sort((a, b) => {
    const av = value(a),
      bv = value(b);
    if (av == null || bv == null)
      return av == null ? (bv == null ? a.id.localeCompare(b.id) : 1) : -1;
    return (
      (typeof av === "string"
        ? av.toLowerCase().localeCompare(String(bv).toLowerCase())
        : av - Number(bv)) * (query.descending ? -1 : 1) || a.id.localeCompare(b.id)
    );
  });
  if (command === "get_session_navigation") {
    const position = rows.findIndex((session) => session.id === args.id);
    return {
      previous: rows[position - 1]?.id ?? null,
      next: position < 0 ? null : (rows[position + 1]?.id ?? null),
      position: position < 0 ? null : position,
      total: rows.length,
    };
  }
  if (command === "export_sessions")
    return {
      filename: "overwatch-sessions.csv",
      content: csv([
        [
          "Session",
          "Agent",
          "Project",
          "Model",
          "Tokens",
          "Uncached input",
          "Cached input",
          "Cache writes",
          "Output",
          "Reasoning (included in output)",
          "Started",
          "Updated",
          "Elapsed ms",
        ],
        ...rows.map((session) => [
          session.title,
          agents[session.agent].name,
          session.cwd,
          session.model,
          totalTokens(session.tokens),
          session.tokens.input,
          session.tokens.cacheRead,
          session.tokens.cacheWrite,
          session.tokens.output,
          session.tokens.reasoning,
          session.startedAt > 0 ? new Date(session.startedAt).toISOString() : null,
          session.updatedAt > 0 ? new Date(session.updatedAt).toISOString() : null,
          elapsed(session.startedAt, session.updatedAt),
        ]),
      ]),
    };
  const limit = Math.min(100, Math.max(1, query.limit)),
    offset = Math.min(query.offset, Math.floor(Math.max(0, rows.length - 1) / limit) * limit);
  const selected = rows.slice(offset, offset + limit);
  return {
    sessions: selected.map((session) => ({ ...session, usage: [], limits: [] })),
    total: rows.length,
    offset,
    limit,
    usage: Object.fromEntries(
      selected.map((session) => {
        const points = usage(session, query.scope),
          tokens = emptyTokens();
        for (const point of points)
          for (const field of Object.keys(tokens) as (keyof typeof tokens)[])
            tokens[field] += point.tokens[field];
        return [
          session.id,
          {
            tokens,
            calls: points.length,
            models: [...new Set(points.map((point) => point.model))],
          },
        ];
      }),
    ),
  };
}
