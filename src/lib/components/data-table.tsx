import { useRef, type ReactNode, type RefObject } from "react";
import {
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowData,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { cn } from "cn";
import { Empty } from "./page";
import { useScrollMargin } from "@/lib/hooks/use-scroll-margin";

const features = tableFeatures({ rowSortingFeature, sortedRowModel: createSortedRowModel() });
export type DataColumn<T extends RowData> = ColumnDef<typeof features, T> & {
  /** Width in pixels; growing columns share any remaining table space. */
  width: number;
  grow?: boolean;
};
export function DataTable<T extends RowData>({
  data,
  columns,
  label,
  rowKey,
  onRowClick,
  scrollRef,
  boxed: boxedProp,
  empty,
  className,
  virtualize = true,
  sorting,
}: {
  virtualize?: boolean;
  sorting?: {
    id: string;
    descending: boolean;
    onChange: (id: string, descending: boolean) => void;
  };
  data: T[];
  columns: DataColumn<T>[];
  label: string;
  rowKey: (row: T) => string;
  /** Keep a native action button in a cell for keyboard and assistive technology access. */
  onRowClick?: (row: T, orderedRows: T[]) => void;
  /** Viewport to virtualize against. Page lists pass the page scroller. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  /** Inner max-height scroller. Defaults to true when `scrollRef` is omitted. */
  boxed?: boolean;
  empty?: ReactNode;
  className?: string;
}) {
  "use no memo";
  const boxed = boxedProp ?? !scrollRef;
  const page = !!scrollRef && !boxed;
  const localScroll = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const scroll = scrollRef ?? localScroll;
  const margin = useScrollMargin(root, scroll, virtualize && page && data.length > 0) ?? 0;
  const table = useTable({ features, data, columns, getRowId: rowKey });
  const rows = table.getRowModel().rows;
  // Virtual owns a mutable viewport instance. Keep this component outside React Compiler.
  // oxlint-disable-next-line react/incompatible-library
  const virtual = useVirtualizer({
    enabled: virtualize,
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 60,
    useAnimationFrameWithResizeObserver: true,
    useFlushSync: false,
    overscan: 8,
    scrollMargin: page ? margin : 0,
  });
  const items = virtualize
    ? virtual.getVirtualItems()
    : rows.map((_, index) => ({ index, start: 0, end: 0 }));
  const lead = items[0] ? Math.max(0, items[0].start - (page ? margin : 0)) : 0;
  const trail =
    virtualize && items.length
      ? Math.max(0, virtual.getTotalSize() - (items[items.length - 1].end - (page ? margin : 0)))
      : 0;
  const direction = (id: string, fallback: false | "asc" | "desc") =>
    sorting ? (sorting.id === id ? (sorting.descending ? "desc" : "asc") : false) : fallback;
  if (!data.length)
    return empty ?? <Empty title="No results">Try a different search or filter.</Empty>;
  return (
    <div
      ref={page ? root : scroll}
      className={cn(
        boxed
          ? "max-h-150 overflow-x-auto overflow-y-scroll rounded-xl scrollbar-gutter-stable"
          : "min-w-0 overflow-x-auto",
        className,
      )}
    >
      <table
        aria-label={label}
        className="w-full table-fixed border-separate border-spacing-0 text-left text-[13px]"
        style={{ minWidth: columns.reduce((width, column) => width + column.width, 0) }}
      >
        <colgroup>
          {columns.map((column, index) => (
            <col key={index} style={{ width: column.grow ? undefined : column.width }} />
          ))}
        </colgroup>
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th
                  key={header.id}
                  scope="col"
                  aria-sort={
                    direction(header.column.id, header.column.getIsSorted()) === "asc"
                      ? "ascending"
                      : direction(header.column.id, header.column.getIsSorted()) === "desc"
                        ? "descending"
                        : "none"
                  }
                  className={cn(
                    "h-10 bg-background px-3 text-xs font-medium whitespace-nowrap text-muted-foreground",
                    boxed && "sticky top-0 z-20 transform-[translateZ(0)]",
                  )}
                >
                  {header.column.getCanSort() ? (
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 rounded py-2 hover:text-foreground"
                      onClick={
                        sorting
                          ? () =>
                              sorting.onChange(
                                header.column.id,
                                sorting.id === header.column.id
                                  ? !sorting.descending
                                  : header.column.getFirstSortDir() === "desc",
                              )
                          : header.column.getToggleSortingHandler()
                      }
                    >
                      <table.FlexRender header={header} />
                      {direction(header.column.id, header.column.getIsSorted()) === "desc" ? (
                        <ArrowDown className="size-3" />
                      ) : direction(header.column.id, header.column.getIsSorted()) === "asc" ? (
                        <ArrowUp className="size-3" />
                      ) : (
                        <ArrowUpDown className="size-3 opacity-40" />
                      )}
                    </button>
                  ) : (
                    <table.FlexRender header={header} />
                  )}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {lead > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: lead }} />
            </tr>
          )}
          {items.map((item) => {
            const row = rows[item.index];
            return (
              <tr
                key={row.id}
                data-row-id={row.id}
                className={cn("group h-15", onRowClick && "cursor-pointer")}
                onClick={
                  onRowClick
                    ? (event) => {
                        if (
                          event.defaultPrevented ||
                          !(event.target instanceof Element) ||
                          event.target.closest(
                            "a, button, input, select, textarea, label, [role='checkbox'], [role='button'], [contenteditable]",
                          )
                        )
                          return;
                        const selection = window.getSelection();
                        if (
                          selection &&
                          !selection.isCollapsed &&
                          selection.containsNode(event.currentTarget, true)
                        )
                          return;
                        onRowClick(
                          row.original,
                          rows.map((row) => row.original),
                        );
                      }
                    : undefined
                }
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className="truncate px-3 py-2 tabular-nums group-focus-within:bg-muted/70 group-hover:bg-muted/70 first:rounded-l-lg last:rounded-r-lg"
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            );
          })}
          {trail > 0 && (
            <tr aria-hidden="true">
              <td colSpan={columns.length} style={{ height: trail }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
