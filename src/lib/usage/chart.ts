import { eachDayOfInterval, format, startOfWeek } from "date-fns";
import { agents, agentIds } from "../agents";
import type { aggregate } from "./analytics";
import { day } from "../format";
import { usageGroups } from "./groups";

export function usageChart(
  stats: ReturnType<typeof aggregate>,
  start: number,
  end: number,
  grouping: "agent" | "model" | "provider",
  metric: "tokens" | "cost",
  weekly: boolean,
) {
  const ranked = usageGroups(stats.models, grouping === "provider" ? "provider" : "model").sort(
    (a, b) => b[metric] - a[metric] || a.key.localeCompare(b.key),
  );
  const top = new Set(
    ranked.slice(0, 5).flatMap((model) => model.offerings.map((offering) => offering.key)),
  );
  const series =
    grouping === "agent"
      ? agentIds
          .map((agent) => ({
            key: agent,
            label: agents[agent].name,
            color: agents[agent].color,
            pricedCalls: [...stats.days.values()].reduce(
              (sum, point) => sum + (point.agentPricedCalls[agent] ?? 0),
              0,
            ),
            total: [...stats.days.values()].reduce(
              (sum, point) =>
                sum +
                (metric === "tokens" ? (point.agents[agent] ?? 0) : (point.agentCosts[agent] ?? 0)),
              0,
            ),
          }))
          .filter((item) => item.total > 0)
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
    series.forEach((item, index) => {
      if (!point) return;
      bucket.values[index] +=
        grouping === "agent"
          ? ((metric === "tokens" ? point.agents : point.agentCosts)[
              item.key as keyof typeof agents
            ] ?? 0)
          : item.key === "__other"
            ? Object.entries(point.models).reduce(
                (sum, [model, values]) => sum + (top.has(model) ? 0 : values[metric]),
                0,
              )
            : (ranked
                .find((group) => group.key === item.key)
                ?.offerings.reduce(
                  (sum, offering) => sum + (point.models[offering.key]?.[metric] ?? 0),
                  0,
                ) ?? 0);
    });
    buckets.set(key, bucket);
  }
  return {
    groupCount: ranked.length,
    series: series.map((item, index) => ({ ...item, dataKey: `series${index}` })),
    points: [...buckets.values()].map(({ values, ...point }) => ({
      ...point,
      ...Object.fromEntries(values.map((value, index) => [`series${index}`, value])),
    })),
  };
}
