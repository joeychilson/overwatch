import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Session } from "@/lib/bindings";
import { catalogOptions } from "@/lib/queries";
import { knownCost } from "@/lib/usage/costs";
import { compact, duration, elapsed, integer, money } from "@/lib/format";
import { aggregate, totalTokens } from "@/lib/usage/analytics";
import { Metric } from "./page";
import { SessionMetric } from "./session-metric";

export function SessionStats({ session }: { session: Session }) {
  const catalog = useQuery(catalogOptions);
  const stats = useMemo(
    () => aggregate([session], catalog.data?.models ?? []),
    [session, catalog.data?.models],
  );
  return (
    <div className="mb-7 grid grid-cols-3 gap-x-6 gap-y-5 min-[1200px]:grid-cols-6">
      <Metric label="Elapsed" value={duration(elapsed(session.startedAt, session.updatedAt))} />
      <Metric label="Turns" value={integer(session.turns)} />
      <Metric label="Messages" value={integer(session.messages)} />
      <SessionMetric label="Tokens" value={compact(totalTokens(session.tokens))}>
        <dl className="space-y-3">
          {(
            [
              ["Uncached input", session.tokens.input],
              ["Cached input", session.tokens.cacheRead],
              ["Cache writes", session.tokens.cacheWrite],
              ["Output", session.tokens.output],
              ["Reasoning · included in output", session.tokens.reasoning],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex justify-between gap-4 text-xs">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="tabular-nums">{integer(value)}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-5 rounded-lg bg-muted/60 p-3">
          <div className="flex justify-between gap-4 text-xs">
            <span className="text-muted-foreground">API equivalent</span>
            <span className="font-medium tabular-nums">{money(knownCost(stats))}</span>
          </div>
          {stats.unpricedCalls > 0 && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              {integer(stats.unpricedCalls)} responses unpriced · {compact(stats.unpriced)} tokens
            </p>
          )}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          {money(stats.recordedCost)} recorded · {money(stats.estimatedCost)} estimated (USD).{" "}
          Recorded costs when available; current catalog rates otherwise. Not your subscription
          bill.
        </p>
        {stats.undatedCalls > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            Includes {integer(stats.undatedCalls)}{" "}
            {stats.undatedCalls === 1 ? "response" : "responses"} without usable timestamps. This
            usage is excluded from Overview date ranges and calendar activity.
          </p>
        )}
      </SessionMetric>
      <SessionMetric
        label="Tool calls"
        value={integer(session.tools.reduce((sum, tool) => sum + tool.calls, 0))}
      >
        {session.tools.length ? (
          <table
            className="w-full table-fixed text-left text-xs"
            aria-label="Session tool activity"
          >
            <colgroup>
              <col />
              <col style={{ width: 44 }} />
              <col style={{ width: 48 }} />
              <col style={{ width: 66 }} />
            </colgroup>
            <thead>
              <tr className="text-[11px] text-muted-foreground">
                <th className="pb-2 font-normal">Tool</th>
                <th className="pb-2 text-right font-normal">Calls</th>
                <th className="pb-2 text-right font-normal">Failed</th>
                <th className="pb-2 text-right font-normal">Elapsed</th>
              </tr>
            </thead>
            <tbody>
              {session.tools.map((tool) => (
                <tr key={tool.name}>
                  <td className="truncate py-2 pr-3 font-mono" title={tool.name}>
                    {tool.name}
                  </td>
                  <td className="text-right tabular-nums">{integer(tool.calls)}</td>
                  <td className="text-right tabular-nums">{tool.failures || "—"}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">
                    {duration(tool.timed > 0 ? tool.durationMs : null)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-xs text-muted-foreground">No tool calls recorded in this session.</p>
        )}
      </SessionMetric>
      <Metric label="Compactions" value={integer(session.compactions)} />
    </div>
  );
}
