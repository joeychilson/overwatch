import { useId, type ReactNode } from "react";

export function RankedList<T>({
  items,
  itemKey,
  value,
  color,
  label,
  description,
  formatValue,
  title,
  ariaLabel,
  onSelect,
  labelClassName = "truncate text-left",
}: {
  items: T[];
  itemKey: (item: T) => string;
  value: (item: T) => number;
  color?: (item: T) => string;
  label: (item: T) => ReactNode;
  description?: (item: T) => ReactNode;
  formatValue: (item: T) => ReactNode;
  title?: (item: T) => string;
  ariaLabel?: (item: T) => string;
  onSelect: (item: T) => void;
  labelClassName?: string;
}) {
  const id = useId();
  const max = Math.max(1, ...items.map(value));
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <button
          key={itemKey(item)}
          type="button"
          className="group block w-full min-w-0 rounded-sm text-left outline-offset-4 focus-visible:outline-2 focus-visible:outline-ring"
          title={title?.(item)}
          aria-label={ariaLabel?.(item)}
          aria-describedby={`${id}-${index}-value${description ? ` ${id}-${index}-description` : ""}`}
          onClick={() => onSelect(item)}
        >
          <span className="mb-2 flex h-9 items-center justify-between gap-4 text-xs">
            <span className="min-w-0">
              <span className={`block group-hover:text-primary ${labelClassName}`}>
                {label(item)}
              </span>
              {description && (
                <span
                  id={`${id}-${index}-description`}
                  className="mt-0.5 block truncate text-[11px] text-muted-foreground"
                >
                  {description(item)}
                </span>
              )}
            </span>
            <span id={`${id}-${index}-value`} className="shrink-0 font-medium tabular-nums">
              {formatValue(item)}
            </span>
          </span>
          <span className="block h-2 rounded-sm" aria-hidden="true">
            <span
              className={
                color
                  ? "block h-full rounded-sm group-hover:brightness-110"
                  : "block h-full rounded-sm bg-chart-2/80 group-hover:brightness-110"
              }
              style={{
                width: `${(value(item) / max) * 100}%`,
                background: color?.(item),
              }}
            />
          </span>
        </button>
      ))}
    </div>
  );
}
