import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import { SlidersHorizontal, X } from "lucide-react";
import type { HistoryScope } from "@/lib/bindings";
import { historyOptions, toolOptions } from "@/lib/history";
import { useModelName } from "@/lib/hooks/use-model-name";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { ErrorNotice, FilterSelect } from "./page";

export function SessionFilters({
  scope,
  model,
  tool,
  failedOnly,
  onChange,
}: {
  scope: HistoryScope;
  model: string | null;
  tool: string | null;
  failedOnly: boolean;
  onChange: (filters: { model: string | null; tool: string | null; failedOnly: boolean }) => void;
}) {
  const [open, setOpen] = useState(false);
  const history = useQuery(historyOptions);
  const tools = useQuery({ ...toolOptions(scope), enabled: open });
  const modelName = useModelName();
  const models = [
    ...new Set((history.data?.offerings ?? []).map((key) => key.slice(key.indexOf("/") + 1))),
  ].sort();
  const count = Number(!!model) + Number(!!tool) + Number(failedOnly);
  const change = (
    patch: Partial<{ model: string | null; tool: string | null; failedOnly: boolean }>,
  ) => onChange({ model, tool, failedOnly, ...patch });
  return (
    <>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger render={<Button variant="outline" />}>
          <SlidersHorizontal /> Filters{count > 0 ? ` (${count})` : ""}
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Positioner
            side="bottom"
            align="end"
            sideOffset={8}
            collisionPadding={16}
            className="z-50"
          >
            <Popover.Popup className="w-80 max-w-(--available-width) rounded-xl bg-popover p-5 text-foreground shadow-xl outline-none">
              <div className="mb-4 flex items-center justify-between">
                <Popover.Title className="text-sm font-medium">Session filters</Popover.Title>
                <Popover.Close
                  render={<Button variant="ghost" size="icon-xs" aria-label="Close filters" />}
                >
                  <X />
                </Popover.Close>
              </div>
              <div className="space-y-4">
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Used model</p>
                  <FilterSelect
                    label="Used model"
                    value={model ?? "all"}
                    onChange={(value) => change({ model: value === "all" ? null : value })}
                    className="w-full"
                    options={[
                      { value: "all", label: "Any model" },
                      ...models.map((value) => ({ value, label: modelName(value) })),
                    ]}
                  />
                </div>
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">Tool</p>
                  <FilterSelect
                    label="Used tool"
                    value={tool ?? "all"}
                    onChange={(value) => change({ tool: value === "all" ? null : value })}
                    className="w-full"
                    options={[
                      { value: "all", label: tools.isPending ? "Loading tools…" : "Any tool" },
                      ...[
                        ...new Set([
                          ...(tools.data ?? []).map((item) => item.name),
                          ...(tool ? [tool] : []),
                        ]),
                      ]
                        .sort()
                        .map((value) => ({ value, label: value })),
                    ]}
                  />
                </div>
                {tools.error && (
                  <ErrorNotice error={tools.error} retry={() => void tools.refetch()} />
                )}
                <label className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={failedOnly}
                    onCheckedChange={(value) => change({ failedOnly: value })}
                  />
                  With failed tool calls
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Applies to the selected tool, or any tool. A failed call doesn’t mean the session
                  failed.
                </p>
              </div>
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}
