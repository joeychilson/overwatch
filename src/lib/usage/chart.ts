import { eachDayOfInterval, format, startOfWeek } from "date-fns";
import { agents, agentIds } from "../agents";
import type { aggregate } from "./analytics";
import { day } from "../format";
import { usageGroups } from "./groups";

export function usageChart(
  stats: Omit<ReturnType<typeof aggregate>, "sessionIds">,
  start: number,
  end: number,
  grouping: "agent" | "model" | "provider",
  metric: "tokens" | "cost",
  weekly: boolean,
) {
  const ranked = (grouping === "agent" ? [] : usageGroups(stats.models, grouping)).sort(
    (a, b) => b[metric] - a[metric] || a.key.localeCompare(b.key),
  );
  const offeringSeries = new Map(
    ranked.flatMap((group, index) =>
      group.offerings.map((offering) => [offering.key, Math.min(index, 5)] as const),
    ),
  );
  const days = [...stats.days.values()];
  const series =
    grouping === "agent"
      ? agentIds
          .filter((agent) => days.some((point) => Object.hasOwn(point.agents, agent)))
          .map((agent) => ({
            key: agent,
            label: agents[agent].name,
            color: agents[agent].color,
            pricedCalls: days.reduce((sum, point) => sum + (point.agentPricedCalls[agent] ?? 0), 0),
            total: days.reduce(
              (sum, point) =>
                sum +
                (metric === "tokens" ? (point.agents[agent] ?? 0) : (point.agentCosts[agent] ?? 0)),
              0,
            ),
          }))
          .sort((a, b) => b.total - a.total)
      : ranked.slice(0, 5).map((model) => ({
          key: model.key,
          label: model.resolved
            ? model.label
            : `${model.label} · ${model.offerings[0].providerName}`,
          color: model.color,
          total: model[metric],
          pricedCalls: model.pricedCalls,
        }));
  if (grouping !== "agent" && ranked.length > 5)
    series.push({
      key: "__other",
      label: grouping === "provider" ? "Other providers" : "Other models",
      color: "var(--chart-6)",
      pricedCalls: ranked.slice(5).reduce((sum, model) => sum + model.pricedCalls, 0),
      total: ranked.slice(5).reduce((sum, model) => sum + model[metric], 0),
    });
  const buckets = new Map<
    string,
    {
      date: string;
      label: string;
      total: number;
      unpricedCalls: number;
      pricedCalls: number;
      recordedCost: number;
      estimatedCost: number;
      values: number[];
    }
  >();
  for (const date of eachDayOfInterval({ start, end })) {
    const key = day(weekly ? startOfWeek(date, { weekStartsOn: 1 }) : date);
    const point = stats.days.get(day(date));
    const bucket = buckets.get(key) ?? {
      date: format(date, "MMM d"),
      label: format(date, "MMM d, yyyy"),
      total: 0,
      unpricedCalls: 0,
      pricedCalls: 0,
      recordedCost: 0,
      estimatedCost: 0,
      values: series.map(() => 0),
    };
    if (weekly) bucket.label = `${bucket.date} – ${format(date, "MMM d, yyyy")}`;
    bucket.total += (metric === "tokens" ? point?.total : point?.cost) ?? 0;
    bucket.unpricedCalls += point?.unpricedCalls ?? 0;
    bucket.pricedCalls += point?.pricedCalls ?? 0;
    bucket.recordedCost += point?.recordedCost ?? 0;
    bucket.estimatedCost += point?.estimatedCost ?? 0;
    if (point) {
      if (grouping === "agent")
        series.forEach((item, index) => {
          bucket.values[index] +=
            (metric === "tokens" ? point.agents : point.agentCosts)[
              item.key as keyof typeof agents
            ] ?? 0;
        });
      else
        for (const [offering, values] of Object.entries(point.models)) {
          const index = offeringSeries.get(offering);
          if (index !== undefined) bucket.values[index] += values[metric];
        }
    }
    buckets.set(key, bucket);
  }
  return {
    series: series.map((item, index) => ({ ...item, dataKey: `series${index}` })),
    points: [...buckets.values()].map(({ values, ...point }) => ({
      ...point,
      ...Object.fromEntries(values.map((value, index) => [`series${index}`, value])),
    })),
  };
}
