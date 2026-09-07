import type { RefObject } from "react";
import type { Session, UsageSummary, SessionQuery } from "@/lib/bindings";
import { agents } from "@/lib/agents";
import { useModelName } from "@/lib/hooks/use-model-name";
import { compact, duration, elapsed, relative } from "@/lib/format";
import { totalTokens } from "@/lib/usage/analytics";
import { DataTable, type DataColumn } from "./data-table";
import { AgentMark } from "./agent-mark";

export function SessionTable({
  sessions,
  onOpen,
  scrollRef,
  boxed,
  usageOnly = false,
  label = "Sessions",
  usage = {},
  query,
  onSort,
}: {
  sessions: Session[];
  usage?: Record<string, UsageSummary>;
  query?: SessionQuery;
  onSort?: (sort: SessionQuery["sort"], descending: boolean) => void;
  usageOnly?: boolean;
  label?: string;
  onOpen: (id: string, orderedIds: string[]) => void;
  scrollRef?: RefObject<HTMLDivElement | null>;
  boxed?: boolean;
}) {
  const modelName = useModelName();
  const tokens = (session: Session) =>
    usageOnly
      ? totalTokens(usage[session.id]?.tokens ?? session.tokens)
      : totalTokens(session.tokens);
  const columns: DataColumn<Session>[] = [
    {
      id: "title",
      accessorKey: "title",
      header: "Session",
      width: 300,
      grow: true,
      cell: ({ row, table }) => (
        <div className="flex items-center gap-3">
          <AgentMark agent={row.original.agent} />
          <div className="min-w-0 flex-1">
            <button
              className="block max-w-full truncate text-left text-[13px] font-medium hover:text-primary"
              title={row.original.title}
              onClick={() =>
                onOpen(
                  row.original.id,
                  table.getRowModel().rows.map((row) => row.original.id),
                )
              }
            >
              {row.original.title}
            </button>
            <p className="mt-1 truncate text-xs text-muted-foreground" title={row.original.model}>
              {agents[row.original.agent].name} <span className="mx-1.5 opacity-40">/</span>{" "}
              {usageOnly
                ? [...new Set((usage[row.original.id]?.models ?? []).map(modelName))].join(", ")
                : modelName(row.original.model)}
            </p>
          </div>
        </div>
      ),
    },
    {
      accessorKey: "project",
      header: "Project",
      width: 144,
      cell: ({ row }) => (
        <span className="block truncate text-muted-foreground" title={row.original.cwd}>
          {row.original.project}
        </span>
      ),
    },
    {
      id: "tokens",
      accessorFn: tokens,
      header: "Tokens",
      width: 96,
      cell: ({ row }) => compact(tokens(row.original)),
    },
  ];
  const trailingColumns: DataColumn<Session>[] = usageOnly
    ? [
        {
          id: "responses",
          header: "Responses",
          accessorFn: (session: Session) => usage[session.id]?.calls ?? 0,
          width: 100,
        },
      ]
    : [
        {
          id: "duration",
          accessorFn: (session) => elapsed(session.startedAt, session.updatedAt) ?? undefined,
          header: "Elapsed",
          width: 108,
          cell: ({ row }) => (
            <span className="text-muted-foreground">
              {duration(elapsed(row.original.startedAt, row.original.updatedAt))}
            </span>
          ),
        },
        {
          accessorKey: "updatedAt",
          header: "Last activity",
          width: 152,
          cell: ({ row }) => (
            <span className="whitespace-nowrap text-muted-foreground">
              {relative(row.original.updatedAt)}
            </span>
          ),
        },
      ];
  columns.push(...trailingColumns);
  return (
    <DataTable
      label={label}
      virtualize={!query}
      sorting={
        query && onSort
          ? {
              id: query.sort,
              descending: query.descending,
              onChange: (id, descending) => {
                if (
                  ["title", "project", "tokens", "duration", "responses", "updatedAt"].includes(id)
                )
                  onSort(id as SessionQuery["sort"], descending);
              },
            }
          : undefined
      }
      data={sessions}
      columns={columns}
      rowKey={(session) => session.id}
      boxed={boxed}
      onRowClick={(session, rows) =>
        onOpen(
          session.id,
          rows.map((row) => row.id),
        )
      }
      scrollRef={scrollRef}
    />
  );
}
