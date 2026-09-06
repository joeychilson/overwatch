import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import type { Session } from "@/lib/bindings";
import { useModelName } from "@/lib/hooks/use-model-name";
import { Input } from "./ui/input";
import { Modal } from "./page";
import { AgentMark } from "./agent-mark";

export function CommandMenu({
  sessions,
  pages,
  onClose,
  openSession,
}: {
  sessions: Session[];
  pages: { label: string; select: () => void }[];
  onClose: () => void;
  openSession: (id: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const modelName = useModelName();
  const query = search.toLowerCase();
  const results = [
    ...pages
      .filter((page) => page.label.toLowerCase().includes(query))
      .map((page) => ({ ...page, detail: "Navigate", agent: null })),
    ...sessions
      .filter((session) =>
        `${session.title} ${session.cwd} ${session.model} ${modelName(session.model)}`
          .toLowerCase()
          .includes(query),
      )
      .slice(0, 30)
      .map((session) => ({
        label: session.title,
        detail: session.project,
        agent: session.agent,
        select: () => openSession(session.id),
      })),
  ];
  function select(index: number) {
    if (!results[index]) return;
    results[index].select();
    onClose();
  }
  function move(index: number) {
    const next = Math.max(0, Math.min(results.length - 1, index));
    setActive(next);
    document.getElementById(`command-${next}`)?.scrollIntoView({ block: "nearest" });
  }
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Search Overwatch"
      description="Jump to a page or a session."
      className="gap-3 sm:max-w-xl"
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="command-results"
          aria-activedescendant={
            results.length ? `command-${Math.min(active, results.length - 1)}` : undefined
          }
          aria-label="Search pages and sessions"
          className="pl-9"
          placeholder="Search pages, sessions, projects…"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              move(active + 1);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              move(active - 1);
            } else if (event.key === "Enter") {
              event.preventDefault();
              select(active);
            }
          }}
        />
      </div>
      <div
        id="command-results"
        role="listbox"
        aria-label="Search results"
        className="max-h-96 overflow-auto"
      >
        {results.map((result, index) => (
          <button
            type="button"
            role="option"
            aria-selected={index === active}
            id={`command-${index}`}
            key={`${result.label}:${index}`}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted aria-selected:bg-primary/10 aria-selected:text-primary"
            onPointerMove={() => setActive(index)}
            onClick={() => select(index)}
          >
            {result.agent ? (
              <AgentMark agent={result.agent} />
            ) : (
              <ArrowUpRight className="mx-1.5 size-4 text-muted-foreground" />
            )}
            <div className="min-w-0">
              <p className="truncate text-[13px]">{result.label}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">{result.detail}</p>
            </div>
          </button>
        ))}
        {!results.length && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No matching pages or sessions.
          </p>
        )}
      </div>
    </Modal>
  );
}
