import type { ReactNode } from "react";

export function RankedList<T>({
  items,
  itemKey,
  value,
  color,
  label,
  formatValue,
  title,
  ariaLabel,
  onSelect,
  labelClassName = "min-w-0 truncate rounded text-left hover:text-primary hover:underline",
}: {
  items: T[];
  itemKey: (item: T) => string;
  value: (item: T) => number;
  color?: (item: T) => string;
  label: (item: T) => ReactNode;
  formatValue: (item: T) => ReactNode;
  title?: (item: T) => string;
  ariaLabel?: (item: T) => string;
  onSelect: (item: T) => void;
  labelClassName?: string;
}) {
  const max = Math.max(1, ...items.map(value));
  return (
    <div className="space-y-4">
      {items.map((item) => (
        <div key={itemKey(item)}>
          <div className="mb-2 flex justify-between gap-3 text-xs">
            <button
              type="button"
              className={labelClassName}
              title={title?.(item)}
              aria-label={ariaLabel?.(item)}
              onClick={() => onSelect(item)}
            >
              {label(item)}
            </button>
            <span className="shrink-0 text-muted-foreground tabular-nums">{formatValue(item)}</span>
          </div>
          <div className="h-1 rounded-full bg-muted">
            <div
              className={color ? "h-full rounded-full" : "h-full rounded-full bg-chart-2/65"}
              style={{
                width: `${(value(item) / max) * 100}%`,
                background: color?.(item),
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
