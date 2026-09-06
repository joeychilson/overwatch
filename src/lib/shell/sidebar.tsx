import { CircleHelp, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { agentIds, agents } from "@/lib/agents";
import type { Agent, Snapshot } from "@/lib/bindings";
import { navigation, type View } from "./navigation";
import { cn } from "@/lib/ui";
import { AgentMark } from "@/lib/components/agent-mark";
import { Button } from "@/lib/components/ui/button";
import appIcon from "../../../src-tauri/icons/icon.svg";

export function AppSidebar({
  collapsed,
  compactWindow,
  view,
  sessionCount,
  agent,
  snapshot,
  saving,
  onNavigate,
  onSelectAgent,
  onSearch,
  onHelp,
  onToggleSidebar,
}: {
  collapsed: boolean;
  compactWindow: boolean;
  view: View;
  sessionCount?: number;
  agent: Agent | "all";
  snapshot?: Snapshot;
  saving: boolean;
  onNavigate: (view: View) => void;
  onSelectAgent: (agent: Agent) => void;
  onSearch: () => void;
  onHelp: () => void;
  onToggleSidebar: () => void;
}) {
  return (
    <aside className="flex min-h-0 flex-col bg-sidebar px-3">
      <div className="h-12 shrink-0" data-tauri-drag-region />
      <button
        className={cn(
          "flex h-12 items-center gap-2 px-1 text-xl font-semibold tracking-tight",
          collapsed && "justify-center px-0",
        )}
        onClick={() => onNavigate("overview")}
        aria-label="Overwatch overview"
      >
        <img src={appIcon} alt="" className="size-9 shrink-0" />
        {!collapsed && (
          <span>
            overwatch<span className="text-primary">.</span>
          </span>
        )}
      </button>
      <button
        onClick={(event) => {
          event.currentTarget.focus();
          onSearch();
        }}
        aria-label="Search anything"
        className={cn(
          "my-5 flex h-9 items-center gap-2.5 rounded-lg px-3 text-xs text-muted-foreground transition-colors hover:bg-muted",
          collapsed && "justify-center px-0",
        )}
      >
        <Search className="size-4" />
        {!collapsed && (
          <>
            <span className="min-w-0 truncate text-left">Search anything</span>
            <kbd className="ml-auto max-[1100px]:hidden">⌘K</kbd>
          </>
        )}
      </button>
      <nav aria-label="Main navigation" className="space-y-1">
        {navigation.map((item) => (
          <button
            key={item.id}
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            aria-current={view === item.id ? "page" : undefined}
            onClick={() => onNavigate(item.id)}
            className={cn(
              "flex h-10 w-full items-center gap-3 rounded-lg px-3 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-[current=page]:bg-primary/10 aria-[current=page]:font-medium aria-[current=page]:text-primary",
              item.id === "subscriptions" && "mt-5",
              collapsed && "justify-center px-0",
            )}
          >
            <item.icon className="size-4.25" strokeWidth={1.7} />
            {!collapsed && (
              <>
                <span>{item.label}</span>
                {item.id === "sessions" && (
                  <span className="ml-auto text-[11px] tabular-nums">{sessionCount || ""}</span>
                )}
              </>
            )}
          </button>
        ))}
      </nav>
      {!collapsed && (
        <div className="mt-8 min-h-0 flex-1 overflow-auto">
          <p className="mb-3 px-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
            Agents
          </p>
          <div className="space-y-1">
            {agentIds
              .filter((id) => id !== "antigravity")
              .map((id) => {
                const source = snapshot?.sources.find((source) => source.source.agent === id);
                return (
                  <button
                    key={id}
                    aria-pressed={agent === id}
                    onClick={() => onSelectAgent(id)}
                    className="flex h-9 w-full items-center gap-2 rounded-lg px-3 text-xs text-muted-foreground hover:bg-muted aria-pressed:bg-muted aria-pressed:text-foreground"
                  >
                    <AgentMark
                      agent={id}
                      className="size-5 rounded-none bg-transparent text-lg [&_img]:size-full"
                    />
                    <span>{agents[id].name}</span>
                    <span
                      className={cn(
                        "ml-auto size-1.5 shrink-0 rounded-full",
                        source?.available && source.source.enabled
                          ? "bg-success"
                          : "bg-muted-foreground/30",
                      )}
                    />
                  </button>
                );
              })}
          </div>
        </div>
      )}
      <div className="mt-auto flex h-16 shrink-0 items-center justify-between px-1">
        {(!collapsed || compactWindow) && (
          <Button variant="ghost" size="icon" aria-label="Help and shortcuts" onClick={onHelp}>
            <CircleHelp className="text-muted-foreground" />
          </Button>
        )}
        {!compactWindow && (
          <Button
            variant="ghost"
            size="icon"
            disabled={saving}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={onToggleSidebar}
          >
            {collapsed ? (
              <PanelLeftOpen className="text-muted-foreground" />
            ) : (
              <PanelLeftClose className="text-muted-foreground" />
            )}
          </Button>
        )}
      </div>
    </aside>
  );
}
