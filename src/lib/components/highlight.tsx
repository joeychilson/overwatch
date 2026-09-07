import { matchRanges } from "@/lib/session/highlight";
export function Highlight({ text, search }: { text: string; search: string }) {
  const parts = [];
  let at = 0;
  for (const match of matchRanges(text, search)) {
    parts.push(text.slice(at, match.start));
    parts.push(
      <mark key={match.start} className="rounded-sm bg-primary/20 text-foreground">
        {text.slice(match.start, match.end)}
      </mark>,
    );
    at = match.end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
