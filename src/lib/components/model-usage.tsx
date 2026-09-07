import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { Session } from "@/lib/bindings";
import type { Model } from "@/lib/models/catalog";
import { aggregate } from "@/lib/usage/analytics";
import { knownCost } from "@/lib/usage/costs";
import { compact, integer, money } from "@/lib/format";
import { rowButton, whenPresent } from "@/lib/components/restore-focus";
import { offeringProviderNames, usageGroups, type UsageGroup } from "@/lib/usage/groups";
import { DataTable, type DataColumn } from "@/lib/components/data-table";
import { ModelDetail } from "@/lib/components/model-detail";
import { Empty, PageTitle, SearchField } from "@/lib/components/page";
import { ProviderMark } from "@/lib/components/provider-mark";
import { Button } from "@/lib/components/ui/button";

export function ModelUsage({
  initialModelKey,
  stats,
  sessions,
  models,
  start,
  end,
  now,
  range,
  scrollRef,
  openCatalog,
}: {
  initialModelKey?: string;
  stats: ReturnType<typeof aggregate>;
  sessions: Session[];
  models: Model[];
  start: number;
  end: number;
  now: number;
  range: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  openCatalog: () => void;
}) {
  const [search, setSearch] = useState("");
  const tableRoot = useRef<HTMLDivElement>(null);
  const listRoot = useRef<HTMLDivElement>(null);
  const listPosition = useRef(0);
  const restore = useRef(false);
  const restoreKey = useRef("");
  const allGroups = useMemo(
    () => usageGroups(aggregate(sessions, models).models, "model"),
    [sessions, models],
  );
  const groups = useMemo(() => usageGroups(stats.models, "model"), [stats.models]);
  const [selected, setSelected] = useState<UsageGroup | undefined>(() =>
    allGroups.find((group) => group.key === initialModelKey),
  );
  const rows = useMemo(
    () =>
      groups.filter((group) =>
        `${group.label} ${group.detail} ${group.offerings.map((offering) => `${offering.providerName} ${offering.model}`).join(" ")}`
          .toLowerCase()
          .includes(search.toLowerCase()),
      ),
    [groups, search],
  );
  const detail = selected
    ? (allGroups.find((group) => group.key === selected.key) ?? selected)
    : undefined;
  const openModel = (group: UsageGroup) => {
    listPosition.current = scrollRef.current?.scrollTop ?? 0;
    setSelected(group);
    scrollRef.current?.scrollTo({ top: 0 });
  };
  useLayoutEffect(() => {
    if (selected || !restore.current) return;
    const root = tableRoot.current;
    if (!root) return;
    if (!rows.some((row) => row.key === restoreKey.current)) {
      restore.current = false;
      scrollRef.current?.scrollTo({ top: 0 });
      listRoot.current?.querySelector("input")?.focus();
      return;
    }
    return whenPresent(root, () => {
      if (!root.querySelector("tbody [data-row-id]")) return false;
      scrollRef.current?.scrollTo({ top: listPosition.current });
      const button = rowButton(root, restoreKey.current);
      if (!button?.getClientRects().length) return false;
      button.focus({ preventScroll: true });
      restore.current = false;
      return true;
    });
  }, [selected, scrollRef, rows]);
  const columns: DataColumn<UsageGroup>[] = [
    {
      id: "model",
      header: "Model",
      accessorFn: (row) => row.label,
      width: 260,
      grow: true,
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <ProviderMark provider={row.original.offerings[0].identity.owner} />
          <div className="min-w-0 flex-1">
            <button
              className="block max-w-full truncate text-left text-[13px] font-medium hover:text-primary"
              title={`${row.original.label} · ${row.original.detail}`}
              onClick={(event) => {
                event.currentTarget.focus();
                openModel(row.original);
              }}
            >
              {row.original.label}
            </button>
            <p
              className="mt-1 truncate text-xs text-muted-foreground"
              title={row.original.offerings.map((offering) => offering.providerName).join(", ")}
            >
              {offeringProviderNames(row.original).join(", ")}
              {!row.original.resolved && " · Separate identity"}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "tokens",
      header: "Tokens",
      accessorKey: "tokens",
      width: 115,
      cell: ({ row }) => (
        <span title={integer(row.original.tokens)}>{compact(row.original.tokens)}</span>
      ),
    },
    {
      id: "share",
      header: "Token share",
      accessorFn: (row) => (stats.total ? row.tokens / stats.total : 0),
      width: 125,
      cell: ({ row }) =>
        stats.total ? `${((row.original.tokens / stats.total) * 100).toFixed(1)}%` : "—",
    },
    {
      id: "cost",
      header: "Known USD",
      accessorFn: (row) => knownCost(row) ?? -1,
      width: 130,
      cell: ({ row }) => (
        <span
          title={
            row.original.unpricedCalls
              ? `${integer(row.original.unpricedCalls)} responses unpriced; known subtotal`
              : "Recorded costs and catalog estimates"
          }
        >
          {money(knownCost(row.original))}
          {row.original.unpricedCalls > 0 && row.original.pricedCalls > 0 ? " *" : ""}
        </span>
      ),
    },
    {
      id: "calls",
      header: "Responses",
      accessorKey: "calls",
      width: 115,
      cell: ({ row }) => integer(row.original.calls),
    },
  ];
  return (
    <>
      <div ref={listRoot} hidden={!!detail}>
        <PageTitle
          title="Models"
          description={`${integer(groups.length)} models across your coding agents.`}
          action={
            <Button variant="outline" onClick={openCatalog}>
              Pricing catalog
            </Button>
          }
        />
        <div className="mb-4">
          <SearchField
            value={search}
            onChange={setSearch}
            placeholder="Find used models or providers…"
          />
        </div>
        <div ref={tableRoot}>
          <DataTable
            label="Model usage"
            data={rows}
            columns={columns}
            rowKey={(row) => row.key}
            scrollRef={scrollRef}
            onRowClick={openModel}
            empty={
              <Empty title={groups.length ? "No matching models" : "No model usage in this period"}>
                Try another search or date range.
              </Empty>
            }
          />
        </div>
        <p className="mt-5 text-xs text-muted-foreground">
          {integer(rows.length)} models · selected period · * partial cost coverage
        </p>
      </div>
      {detail && (
        <ModelDetail
          key={detail.key}
          group={detail}
          sessions={sessions}
          models={models}
          start={start}
          end={end}
          now={now}
          range={range}
          scrollRef={scrollRef}
          onClose={() => {
            restoreKey.current = detail.key;
            restore.current = true;
            setSelected(undefined);
          }}
        />
      )}
    </>
  );
}
