import { useId, useState } from "react";
import { eachDayOfInterval, format, startOfWeek, subDays } from "date-fns";
import { Tooltip } from "@base-ui/react/tooltip";
import type { Session } from "@/lib/bindings";
import type { aggregate } from "@/lib/usage/analytics";
import { compact, day, duration, integer } from "@/lib/format";
import { ChartHoverCard } from "@/lib/components/ui/chart";
import { Section } from "@/lib/components/page";

export function ActivityHeatmap({
  lifetime,
  sessions,
  now,
  openDay,
}: {
  lifetime: ReturnType<typeof aggregate>;
  sessions: Session[];
  now: number;
  openDay: (day: string) => void;
}) {
  const [activityTooltip] = useState(() => Tooltip.createHandle<{ date: Date; amount: number }>());
  const activityTooltipId = useId();
  const heatDays = eachDayOfInterval({
    start: startOfWeek(subDays(now, 364), { weekStartsOn: 1 }),
    end: now,
  });
  const heatValues = heatDays.map((date) => ({
    date,
    amount: lifetime.days.get(day(date))?.total ?? 0,
  }));
  const maxHeat = Math.max(1, ...heatValues.map((value) => value.amount));
  return (
    <Section title="Activity">
      <Tooltip.Provider delay={100}>
        <div className="overflow-x-auto pb-2">
          <div
            className="grid h-32 min-w-full grid-flow-col grid-rows-7 gap-1.25"
            style={{
              gridTemplateColumns: `repeat(${Math.ceil(heatDays.length / 7)},minmax(9px,1fr))`,
            }}
          >
            {heatValues.map(({ date, amount }) => (
              <Tooltip.Trigger
                key={day(date)}
                handle={activityTooltip}
                render={(props, state) => (
                  <button
                    {...props}
                    aria-describedby={state.open ? activityTooltipId : undefined}
                  />
                )}
                payload={{ date, amount }}
                aria-label={`${format(date, "MMMM d, yyyy")}: ${integer(amount)} tokens`}
                onClick={() => openDay(day(date))}
                className="min-w-2.25 rounded-[3px] transition-colors hover:ring-2 hover:ring-primary"
                style={{
                  background:
                    amount === 0
                      ? "var(--heatmap-0)"
                      : `color-mix(in oklab, var(--primary) ${20 + Math.ceil((amount / maxHeat) * 4) * 20}%, var(--heatmap-0))`,
                }}
              />
            ))}
          </div>
        </div>
        <Tooltip.Root handle={activityTooltip}>
          {({ payload }) => (
            <Tooltip.Portal>
              <Tooltip.Positioner side="top" sideOffset={8} collisionPadding={12} className="z-50">
                <Tooltip.Popup id={activityTooltipId} role="tooltip" render={<ChartHoverCard />}>
                  {payload && (
                    <>
                      <p className="font-medium">{format(payload.date, "EEEE, MMM d, yyyy")}</p>
                      <div className="flex items-center justify-between gap-8">
                        <span className="text-muted-foreground">Daily tokens</span>
                        <span className="tabular-nums">{integer(payload.amount)}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">Click to view sessions</p>
                    </>
                  )}
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          )}
        </Tooltip.Root>
      </Tooltip.Provider>
      <div className="mt-3 flex justify-between text-xs text-muted-foreground">
        <span>{format(heatDays[0], "MMM d, yyyy")}</span>
        <span>{format(now, "MMM d, yyyy")}</span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {compact(lifetime.total)} lifetime tokens ·{" "}
        {duration(
          sessions.reduce(
            (longest, session) => Math.max(longest, session.updatedAt - session.startedAt),
            0,
          ),
        )}{" "}
        longest session
      </p>
    </Section>
  );
}
