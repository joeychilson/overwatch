import { RefreshCw } from "lucide-react";
import { agentIds, agents } from "@/lib/agents";
import type { Agent } from "@/lib/bindings";
import type { View } from "./navigation";
import { cn } from "cn";
import { FilterSelect } from "@/lib/components/page";

export function AppHeader({
  scoped,
  readingSession,
  project,
  projects,
  agent,
  range,
  view,
  nativeApp,
  syncing,
  scanning,
  snapshotError,
  onProject,
  onAgent,
  onRange,
  onSync,
}: {
  scoped: boolean;
  readingSession: boolean;
  project: string;
  projects: [string, string][];
  agent: Agent | "all";
  range: string;
  view: View;
  nativeApp: boolean;
  syncing: boolean;
  scanning?: boolean;
  snapshotError: boolean;
  onProject: (value: string) => void;
  onAgent: (value: Agent | "all") => void;
  onRange: (value: string) => void;
  onSync: () => void;
}) {
  return (
    <header
      className={cn(
        "relative z-30 flex shrink-0 items-center gap-3 bg-background px-9 max-[1100px]:px-6 max-[800px]:flex-wrap max-[800px]:gap-2 max-[800px]:px-4",
        readingSession ? "h-12" : "h-20 max-[800px]:h-auto max-[800px]:min-h-20 max-[800px]:py-3",
      )}
      data-tauri-drag-region
    >
      {scoped && (
        <FilterSelect
          label="Project scope"
          value={project}
          onChange={onProject}
          className="mr-auto max-w-60"
          options={[
            { value: "all", label: "All projects" },
            ...projects.map(([value, label]) => ({ value, label })),
          ]}
        />
      )}
      {scoped && (
        <FilterSelect
          label="Agent scope"
          value={agent}
          onChange={onAgent}
          options={[
            { value: "all", label: "All agents" },
            ...agentIds.map((id) => ({ value: id, label: agents[id].name })),
          ]}
        />
      )}
      {(view === "overview" || view === "models") && (
        <FilterSelect
          label="Date range"
          value={range}
          onChange={onRange}
          options={[
            { value: "7", label: "Last 7 days" },
            { value: "30", label: "Last 30 days" },
            { value: "90", label: "Last 90 days" },
            { value: "365", label: "Last year" },
          ]}
        />
      )}
      <button
        disabled={syncing || !nativeApp}
        onClick={onSync}
        title="Reads local changes every four seconds. Click to rescan."
        className={cn(
          "ml-2 flex items-center gap-2 whitespace-nowrap text-[11px]",
          scoped ? "" : "ml-auto",
          snapshotError ? "text-warning" : "text-success",
        )}
      >
        {syncing || scanning ? (
          <RefreshCw className="size-3 animate-spin" />
        ) : (
          <span className="size-1.5 rounded-full bg-current" />
        )}
        {!nativeApp
          ? "Desktop required"
          : snapshotError
            ? "Sync issue"
            : syncing || scanning
              ? "Indexing"
              : "Live"}
      </button>
    </header>
  );
}
