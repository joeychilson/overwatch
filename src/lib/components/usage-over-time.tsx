import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts";
import type { aggregate } from "@/lib/usage/analytics";
import { usageChart } from "@/lib/usage/chart";
import { compact, integer, money } from "@/lib/format";
import { Button } from "./ui/button";
import { ChartContainer, ChartHoverCard } from "./ui/chart";
import { FilterSelect, Section } from "./page";

export function UsageOverTime({
  stats,
  start,
  now,
  range,
  visible = true,
}: {
  stats: ReturnType<typeof aggregate>;
  start: number;
  now: number;
  range: number;
  visible?: boolean;
}) {
  const [metric, setMetric] = useState<"tokens" | "cost">("tokens");
  const [grouping, setGrouping] = useState<"agent" | "model" | "provider">("agent");
  const chart = useMemo(
    () => usageChart(stats, start, now, grouping, metric, range > 90),
    [stats, start, now, grouping, metric, range],
  );
  const display = metric === "cost" ? money : compact;
  return (
    <Section
      title="Usage over time"
      action={
        <div className="flex items-center gap-2">
          <FilterSelect
            label="Group usage by"
            value={grouping}
            onChange={setGrouping}
            options={[
              { value: "agent", label: "By agent" },
              { value: "model", label: "By model" },
              { value: "provider", label: "By provider" },
            ]}
          />
          <div className="flex rounded-lg bg-muted/60 p-1">
            {(["tokens", "cost"] as const).map((option) => (
              <Button
                key={option}
                size="xs"
                variant={metric === option ? "secondary" : "ghost"}
                aria-pressed={metric === option}
                onClick={() => setMetric(option)}
              >
                {option === "cost" ? "API equivalent" : "Tokens"}
              </Button>
            ))}
          </div>
        </div>
      }
    >
      {metric === "cost" && stats.pricedCalls === 0 && (
        <p role="status" className="mb-4 rounded-lg bg-muted p-4 text-sm text-muted-foreground">
          {stats.calls
            ? "Cost unavailable: no responses in this period have recorded costs or exact catalog rates."
            : "No usage recorded in this period."}
        </p>
      )}
      {visible && (
        <ChartContainer
          aria-label={`Usage over time by ${grouping}`}
          className="aspect-auto h-64 w-full min-w-0"
        >
          <BarChart
            data={chart.points}
            margin={{ left: 0, right: 8, top: 8, bottom: 0 }}
            accessibilityLayer
            barCategoryGap="20%"
            maxBarSize={28}
          >
            <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
            <XAxis
              dataKey="date"
              axisLine={false}
              tickLine={false}
              minTickGap={45}
              tickMargin={14}
            />
            <YAxis
              width={52}
              axisLine={false}
              tickLine={false}
              tickFormatter={display}
              tickMargin={10}
            />
            <Tooltip
              cursor={{ fill: "var(--muted)", fillOpacity: 0.5 }}
              content={({ active, payload }) => {
                const point = payload?.[0]?.payload;
                if (!active || !point) return null;
                return (
                  <ChartHoverCard className="w-80 max-w-[calc(100vw-2rem)]">
                    <p className="font-medium">{point.label}</p>
                    {chart.series
                      .filter((item) => point[item.dataKey] > 0)
                      .map((item) => (
                        <div key={item.dataKey} className="flex items-center gap-2">
                          <span
                            className="size-2 shrink-0 rounded-sm"
                            style={{ background: item.color }}
                          />
                          <span
                            className="min-w-0 flex-1 truncate text-muted-foreground"
                            title={item.label}
                          >
                            {item.label}
                          </span>
                          <span className="shrink-0 tabular-nums">
                            {metric === "cost"
                              ? money(point[item.dataKey])
                              : integer(point[item.dataKey])}
                          </span>
                        </div>
                      ))}
                    <div className="mt-1 flex justify-between gap-4 font-medium">
                      <span>Total {metric === "tokens" ? "tokens" : "API equivalent"}</span>
                      <span className="tabular-nums">
                        {metric === "cost"
                          ? money(point.pricedCalls > 0 ? point.total : null)
                          : integer(point.total)}
                      </span>
                    </div>
                    {metric === "cost" && point.unpricedCalls > 0 && (
                      <p className="text-xs text-muted-foreground">
                        {integer(point.unpricedCalls)} responses unpriced · known subtotal
                      </p>
                    )}
                  </ChartHoverCard>
                );
              }}
            />
            {chart.series.map((item) => (
              <Bar
                key={item.dataKey}
                dataKey={item.dataKey}
                stackId="usage"
                fill={item.color}
                isAnimationActive={false}
              />
            ))}
          </BarChart>
        </ChartContainer>
      )}
      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-3" aria-label="Usage breakdown">
        {chart.series.map((item) => (
          <div
            key={item.dataKey}
            className="flex max-w-full min-w-0 items-center gap-2 text-xs"
            title={item.label}
          >
            <span className="size-1.5 shrink-0 rounded-full" style={{ background: item.color }} />
            <span className="max-w-60 truncate text-muted-foreground">{item.label}</span>
            <span className="shrink-0 tabular-nums">
              {metric === "cost" && item.pricedCalls === 0 ? "—" : display(item.total)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        {range > 90 ? "Weekly totals" : "Daily totals"} · local time (
        {Intl.DateTimeFormat().resolvedOptions().timeZone}) ·{" "}
        {metric === "cost" && stats.pricedCalls === 0
          ? "—"
          : display((metric === "cost" ? stats.cost : stats.total) / range)}{" "}
        {metric === "tokens" ? "tokens" : "API equivalent"} per day
        {grouping !== "agent" && chart.groupCount > 5
          ? ` · Top 5 ${grouping}s; remaining usage included in Other`
          : ""}
        {metric === "cost"
          ? ` · Not your subscription bill${stats.unpricedCalls ? ` · ${integer(stats.unpricedCalls)} responses unpriced · known subtotal` : ""}`
          : ` · ${integer(stats.calls)} recorded model responses`}
      </p>
      {metric === "cost" && stats.pricedCalls > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          USD · {money(stats.recordedCost)} recorded · {money(stats.estimatedCost)} estimated at
          current catalog rates
        </p>
      )}
    </Section>
  );
}
