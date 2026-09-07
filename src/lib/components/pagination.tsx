import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
import { integer } from "@/lib/format";

export function Pagination({
  total,
  offset,
  limit,
  busy = false,
  onPage,
}: {
  total: number;
  offset: number;
  limit: number;
  busy?: boolean;
  onPage: (offset: number) => void;
}) {
  return (
    <nav
      aria-label="Session pages"
      className="my-4 flex items-center justify-between gap-3 text-xs text-muted-foreground"
    >
      <span aria-live="polite">
        {total > limit
          ? `${integer(offset + 1)}–${integer(Math.min(total, offset + limit))} of ${integer(total)} sessions`
          : `${integer(total)} sessions`}
      </span>
      {total > limit && (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="Previous page"
            disabled={busy || offset === 0}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            <ChevronLeft /> Previous
          </Button>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Next page"
            disabled={busy || offset + limit >= total}
            onClick={() => onPage(offset + limit)}
          >
            Next <ChevronRight />
          </Button>
        </div>
      )}
    </nav>
  );
}
