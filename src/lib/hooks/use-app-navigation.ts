import { useCallback, type RefObject, type SetStateAction } from "react";
import type { Agent } from "@/lib/bindings";
import { historyScope, sessionQuery } from "@/lib/history";
import { initialWorkspace, type Route } from "@/lib/workspace";
import type { View } from "@/lib/navigation";
import type { Workspace } from "./use-workspace";

export function useAppNavigation(workspace: Workspace, scroll: RefObject<HTMLDivElement | null>) {
  const { change } = workspace;
  const { agent, project } = workspace.state;
  const setRoute = useCallback(
    (value: SetStateAction<Route>, push = true) =>
      change(
        (previous) => ({
          ...previous,
          route: typeof value === "function" ? value(previous.route) : value,
        }),
        push,
      ),
    [change],
  );
  const setAgent = (agent: Agent | "all") =>
    change((previous) => ({
      ...previous,
      agent,
    }));
  const setProject = (project: string) =>
    change((previous) => ({
      ...previous,
      project,
    }));
  const setRange = (range: string) =>
    change((previous) => ({ ...previous, range: range as typeof previous.range }));
  const scope = historyScope({
    project: project === "all" ? null : project,
    agent: agent === "all" ? null : agent,
  });
  const navigate = (view: View) => {
    setRoute({ view });
    scroll.current?.scrollTo({ top: 0 });
  };

  const openSession = (id: string, query = sessionQuery(scope)) => {
    setRoute((route) => ({
      ...(route.view === "sessions" ? route : {}),
      view: "sessions",
      id,
      query,
    }));
    scroll.current?.scrollTo({ top: 0 });
  };

  function openFilteredSessions(filter: { day: string } | { tool: string }) {
    change(
      (previous) => ({
        ...previous,
        route: { view: "sessions", ...filter },
        sessions: { ...initialWorkspace.sessions },
      }),
      true,
    );
    scroll.current?.scrollTo({ top: 0 });
  }

  function clearScope() {
    change((previous) => ({ ...previous, project: "all", agent: "all" }));
  }

  function searchSessions(search: string) {
    clearScope();
    change(
      (previous) => ({
        ...previous,
        route: { view: "sessions" },
        sessions: { ...initialWorkspace.sessions, search },
      }),
      true,
    );
    scroll.current?.scrollTo({ top: 0 });
  }

  return {
    scope,
    setRoute,
    setAgent,
    setProject,
    setRange,
    navigate,
    openSession,
    openFilteredSessions,
    clearScope,
    searchSessions,
  };
}
