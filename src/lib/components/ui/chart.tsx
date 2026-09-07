import type { ComponentProps } from "react";
import { cn } from "cn";
import { ResponsiveContainer } from "recharts";

const INITIAL_DIMENSION = { width: 320, height: 200 } as const;

function ChartContainer({
  className,
  children,
  ...props
}: ComponentProps<"div"> & {
  children: ComponentProps<typeof ResponsiveContainer>["children"];
}) {
  return (
    <div
      data-slot="chart"
      className={cn(
        "flex aspect-video justify-center text-xs [&_.recharts-text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-dot[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-polar-grid_[stroke='#ccc']]:stroke-border [&_.recharts-radial-bar-background-sector]:fill-muted [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-reference-line_[stroke='#ccc']]:stroke-border [&_.recharts-sector]:outline-hidden [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-surface]:outline-hidden",
        className,
      )}
      {...props}
    >
      <ResponsiveContainer initialDimension={INITIAL_DIMENSION}>{children}</ResponsiveContainer>
    </div>
  );
}

export function ChartHoverCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid min-w-32 items-start gap-2 rounded-xl bg-popover p-3 text-xs text-popover-foreground shadow-lg",
        className,
      )}
      {...props}
    />
  );
}

export { ChartContainer };
