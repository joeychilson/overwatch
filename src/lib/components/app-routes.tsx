import { lazy, type RefObject } from "react";
import type { HistoryStatus } from "@/lib/bindings";
import { useWorkspace } from "@/lib/hooks/use-workspace";
import { useAppNavigation } from "@/lib/hooks/use-app-navigation";
import { useNow } from "@/lib/hooks/use-now";

const Overview = lazy(() => import("@/pages/overview"));
const Sessions = lazy(() => import("@/pages/sessions"));
const Models = lazy(() => import("@/pages/models"));
const Subscriptions = lazy(() => import("@/pages/subscriptions"));
const Connections = lazy(() => import("@/pages/connections"));

export function AppRoutes({
  snapshot,
  scroll,
}: {
  snapshot?: HistoryStatus;
  scroll: RefObject<HTMLDivElement | null>;
}) {
  const workspace = useWorkspace();
  const { route, range } = workspace.state;
  const { scope, setRoute, navigate, openSession, openFilteredSessions, clearScope } =
    useAppNavigation(workspace, scroll);
  const now = useNow();
  return (
    <>
      {route.view === "overview" && (
        <Overview
          scope={scope}
          sessionCount={snapshot?.sessionCount ?? 0}
          scanning={snapshot?.scanning ?? false}
          detectedSources={
            snapshot?.sources.filter((source) => source.source.enabled && source.available)
              .length ?? 0
          }
          range={Number(range)}
          now={now}
          openSession={openSession}
          openDay={(day) => openFilteredSessions({ day })}
          openModel={(modelKey) => {
            setRoute({ view: "models", modelKey });
            scroll.current?.scrollTo({ top: 0 });
          }}
          openTool={(tool) => openFilteredSessions({ tool })}
          clearScope={clearScope}
          navigate={navigate}
        />
      )}
      {route.view === "sessions" && (
        <Sessions
          scope={scope}
          selected={route.id}
          selectedQuery={route.query}
          scrollRef={scroll}
          selectedDay={route.day}
          selectedTool={route.tool}
          openSession={openSession}
          clearSelection={() => setRoute({ ...route, id: undefined })}
          clearDay={() => setRoute({ ...route, day: undefined })}
          clearTool={() => setRoute({ ...route, tool: undefined })}
          now={now}
        />
      )}
      {route.view === "models" && (
        <Models
          modelKey={route.modelKey}
          pricing={route.pricing ?? false}
          reading={route.reading}
          onRoute={(patch) => setRoute({ ...route, ...patch })}
          scope={scope}
          offerings={snapshot?.offerings ?? []}
          range={Number(range)}
          now={now}
          scrollRef={scroll}
        />
      )}
      {route.view === "subscriptions" && <Subscriptions now={now} />}
      {route.view === "connections" && (
        <Connections
          sources={snapshot?.sources ?? []}
          openSubscriptions={() => navigate("subscriptions")}
        />
      )}
    </>
  );
}
