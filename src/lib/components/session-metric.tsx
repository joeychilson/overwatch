import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { ChevronDown, X } from "lucide-react";
import { Button } from "./ui/button";

export function SessionMetric({
  label,
  value,
  children,
}: {
  label: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <Popover.Root>
      <div className="min-w-0 py-1">
        <Popover.Trigger
          className="group flex items-center gap-1.5 rounded text-xs text-muted-foreground hover:text-foreground data-popup-open:text-foreground"
          aria-label={`${label} breakdown`}
        >
          {label}
          <ChevronDown className="size-3 transition-transform group-data-popup-open:rotate-180" />
        </Popover.Trigger>
        <p className="mt-3 text-[28px] leading-none font-medium tracking-tight tabular-nums">
          {value}
        </p>
      </div>
      <Popover.Portal>
        <Popover.Positioner
          side="bottom"
          align="start"
          sideOffset={12}
          collisionPadding={16}
          className="z-50"
        >
          <Popover.Popup className="max-h-(--available-height) w-96 max-w-(--available-width) overflow-auto rounded-xl bg-popover p-5 text-foreground shadow-xl outline-none">
            <div className="mb-5 flex items-center justify-between gap-4">
              <Popover.Title className="text-sm font-medium">{label} breakdown</Popover.Title>
              <Popover.Close
                render={<Button variant="ghost" size="icon-xs" aria-label="Close breakdown" />}
              >
                <X />
              </Popover.Close>
            </div>
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
