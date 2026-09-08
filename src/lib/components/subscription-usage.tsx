import { format, formatDistanceStrict, isSameDay } from "date-fns";
import { Line, LineChart, XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip } from "recharts";
import { reachesLimitBeforeReset, type Forecast } from "@/lib/usage/forecast";
import { cn } from "cn";
import { ChartContainer, ChartHoverCard } from "./ui/chart";

export function Allowance({ forecast, now }: { forecast: Forecast; now: number }) {
  const { latest, state } = forecast;
  const expired = state === "expired";
  const stale = state === "stale";
  const remaining = Math.max(0, 100 - latest.usedPercent);
  const runsOut = reachesLimitBeforeReset(forecast);
  const pace = expired
    ? "Refresh to read the new allowance window."
    : stale
      ? "Refresh usage for a current pace estimate."
      : remaining <= 0
        ? "Allowance used up."
        : runsOut && forecast.exhaustionAt != null
          ? forecast.exhaustionAt <= now
            ? "May already be used up at the recent pace."
            : `May run out ${formatDistanceStrict(forecast.exhaustionAt, now, { addSuffix: true })} at this pace.`
          : state === "projected" && forecast.atReset != null
            ? `About ${(100 - forecast.atReset).toFixed(0)}% left at reset at this pace.`
            : state === "steady"
              ? "No increase in recent readings."
              : "Pace estimate needs more readings.";
  return (
    <section className="rounded-xl bg-card p-5" aria-label={`${latest.label} allowance`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{latest.label}</h3>
        {(expired || stale) && (
          <span className="text-xs text-warning">
            {expired ? "Window ended" : "Refresh needed"}
          </span>
        )}
      </div>
      <div className="mt-5 flex items-end justify-between gap-4">
        <p className="text-4xl leading-none tracking-tight tabular-nums">
          {expired ? "—" : remaining.toFixed(0)}
          {!expired && <span className="ml-1 text-lg text-muted-foreground">%</span>}
          <span className="ml-2 text-xs tracking-normal text-muted-foreground">
            {expired ? "ended" : "left"}
          </span>
        </p>
        <span className="text-xs text-muted-foreground tabular-nums">
          {latest.usedPercent.toFixed(0)}% used
        </span>
      </div>
      <div
        className="mt-4 h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={`${latest.label} quota remaining`}
        aria-valuenow={remaining}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={cn("h-full rounded-full bg-primary", remaining <= 10 && "bg-warning")}
          style={{ width: `${remaining}%` }}
        />
      </div>
      <p
        className={cn(
          "mt-4 text-xs leading-relaxed text-muted-foreground",
          runsOut && "text-warning",
        )}
        title={
          state === "collecting"
            ? "At least three readings over 15 minutes are needed to estimate pace."
            : undefined
        }
      >
        {pace}
      </p>
      <div className="mt-5 flex flex-wrap justify-between gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {latest.resetsAt
            ? `${expired ? "Ended" : "Resets"} ${formatDistanceStrict(latest.resetsAt, now, { addSuffix: true })}`
            : "Reset time unavailable"}
        </span>
        {latest.resetsAt && (
          <time dateTime={new Date(latest.resetsAt).toISOString()}>
            {format(latest.resetsAt, "MMM d, HH:mm")}
          </time>
        )}
      </div>
    </section>
  );
}

export function UsageHistory({ forecast }: { forecast: Forecast }) {
  const { latest, samples } = forecast;
  return (
    <>
      {samples.length > 1 ? (
        <ChartContainer
          className="aspect-auto h-40 w-full"
          aria-label={`${latest.label} usage history`}
        >
          <LineChart data={samples} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="timestamp"
              type="number"
              scale="time"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(time: number) => format(time, "HH:mm")}
              axisLine={false}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 50, 100]}
              tickFormatter={(value: number) => `${value}%`}
              width={38}
              axisLine={false}
              tickLine={false}
            />
            <ReferenceLine y={100} stroke="var(--border)" strokeDasharray="3 3" />
            <Tooltip
              content={({ active, payload }) => {
                const value = payload?.[0]?.value;
                if (!active || typeof value !== "number") return null;
                return (
                  <ChartHoverCard>
                    <div className="font-medium">Recorded usage</div>
                    <div className="grid gap-1.5">
                      <div className="flex w-full flex-wrap items-center gap-2">
                        <span className="font-mono tabular-nums">{value.toFixed(1)}% used</span>
                      </div>
                    </div>
                  </ChartHoverCard>
                );
              }}
            />
            <Line
              dataKey="usedPercent"
              stroke="var(--chart-1)"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ChartContainer>
      ) : (
        <p className="py-5 text-sm text-muted-foreground">
          The history chart will appear after another usage reading.
        </p>
      )}
      <p className="mt-3 text-[11px] text-muted-foreground">
        {format(samples[0].timestamp, "MMM d, HH:mm")}
        {samples.length > 1 &&
          `–${format(latest.timestamp, isSameDay(samples[0].timestamp, latest.timestamp) ? "HH:mm" : "MMM d, HH:mm")}`}
      </p>
    </>
  );
}
