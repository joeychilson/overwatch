import { useMemo } from "react";
import { useQuery, useSuspenseQueries } from "@tanstack/react-query";
import { addDays, startOfDay, subDays } from "date-fns";
import type { HistoryScope } from "@/lib/bindings";
import {
  historyScope,
  reportStats,
  sessionOptions,
  sessionQuery,
  toolOptions,
  usageOptions,
} from "@/lib/history";
import { catalogOptions } from "@/lib/queries";
import { emptyModels } from "@/lib/models/catalog";

export function useOverviewData(scope: HistoryScope, range: number, now: number) {
  const catalog = useQuery(catalogOptions);
  const models = catalog.data?.models ?? emptyModels;
  const start = startOfDay(subDays(now, range - 1)).getTime();
  const end = addDays(startOfDay(now), 1).getTime();
  const period = historyScope({ ...scope, start, end });
  // Start all independent reads before suspending the page. Keep the shared
  // query keys so navigation and native events reuse and invalidate the same data.
  const [current, lifetime, previous, recent, sessions, tools] = useSuspenseQueries({
    queries: [
      usageOptions(period, catalog.data?.updatedAt),
      usageOptions(scope, catalog.data?.updatedAt),
      usageOptions(
        historyScope({ ...scope, start: subDays(start, range).getTime(), end: start }),
        catalog.data?.updatedAt,
      ),
      sessionOptions(sessionQuery(scope, { activityAfter: start, activityBefore: end, limit: 5 })),
      sessionOptions(sessionQuery(scope, { limit: 1 })),
      toolOptions(period),
    ],
  });
  const stats = useMemo(() => reportStats(current.data, models), [current.data, models]);
  const lifetimeStats = useMemo(() => reportStats(lifetime.data, models), [lifetime.data, models]);
  const previousStats = useMemo(() => reportStats(previous.data, models), [previous.data, models]);
  return {
    start,
    stats,
    lifetime: lifetimeStats,
    previous: previousStats,
    recent: recent.data,
    scopedSessions: sessions.data.total,
    tools: tools.data,
  };
}
