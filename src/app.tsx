import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { Toaster } from "sonner";
import { commands, type Agent } from "@/lib/bindings";
import { historyOptions, historyScope, sessionQuery } from "@/lib/history";
import { AppFailure, native } from "@/lib/errors";
import { catalogOptions } from "@/lib/queries";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { useNativeEvents } from "@/lib/hooks/use-native-events";
import { useNow } from "@/lib/hooks/use-now";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { WorkspaceContext, useWorkspaceOwner } from "@/lib/hooks/use-workspace";
import { initialWorkspace, type Route } from "@/lib/workspace";
import { navigation, type View } from "@/lib/navigation";
import { cn } from "cn";
import { AppHeader } from "@/lib/components/app-header";
import { AppSidebar } from "@/lib/components/app-sidebar";
import { PageSkeleton, ReaderSkeleton } from "@/lib/components/page-skeleton";
import { Empty, ErrorNotice, Modal } from "@/lib/components/page";
import { CommandMenu } from "@/lib/components/command-menu";
import { ErrorBoundary } from "@/lib/components/error-boundary";

const Overview = lazy(() => import("@/pages/overview"));
const Sessions = lazy(() => import("@/pages/sessions"));
const Models = lazy(() => import("@/pages/models"));
const Subscriptions = lazy(() => import("@/pages/subscriptions"));
const Connections = lazy(() => import("@/pages/connections"));

export default function App() {
  const scroll = useRef<HTMLDivElement>(null);
  const workspace = useWorkspaceOwner(scroll);
  const { change } = workspace;
  const { route, agent, project, range } = workspace.state;
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const compactWindow = useMediaQuery("(max-width: 799px)");
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const now = useNow();
  const client = useQueryClient();
  const snapshot = useQuery(historyOptions);
  const catalog = useQuery(catalogOptions);
  const {
    preferences,
    save,
    saving,
    error: preferenceError,
    refetch: refetchPreferences,
  } = usePreferences();

  const sync = useMutation({
    mutationFn: () => native(commands.refreshHistory()),
    onSuccess: (snapshot) => client.setQueryData(historyOptions.queryKey, snapshot),
  });

  useNativeEvents();

  useEffect(() => {
    document.documentElement.classList.toggle(
      "dark",
      preferences.theme === "dark" || (preferences.theme === "system" && prefersDark),
    );
  }, [preferences.theme, prefersDark]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((value) => !value);
      }
      const item = navigation[Number(event.key) - 1];
      if (
        item &&
        !(
          event.target instanceof HTMLInputElement ||
          event.target instanceof HTMLTextAreaElement ||
          event.target instanceof HTMLSelectElement
        )
      ) {
        event.preventDefault();
        setRoute({ view: item.id });
        scroll.current?.scrollTo({ top: 0 });
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, [setRoute]);

  const scope = historyScope({
    project: project === "all" ? null : project,
    agent: agent === "all" ? null : agent,
  });
  const projects = snapshot.data?.projects ?? [];
  useEffect(() => {
    if (!snapshot.data || snapshot.data.scanning) return;
    if (project !== "all" && !snapshot.data.projects.some(([key]) => key === project))
      change((previous) => ({ ...previous, project: "all" }));
    if (
      agent !== "all" &&
      !snapshot.data.sources.some(
        (source) => source.source.agent === agent && source.source.enabled,
      )
    )
      change((previous) => ({ ...previous, agent: "all" }));
  }, [snapshot.data, project, agent, change]);

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

  const collapsed = compactWindow || preferences.sidebarCollapsed;
  const readingSession = route.view === "sessions" && !!route.id;
  const scoped = !["connections", "subscriptions"].includes(route.view) && !readingSession;
  const issues = snapshot.data?.sources.filter((source) => source.issues.length) ?? [];
  const nativeApp = isTauri();
  const loading = readingSession ? (
    <>
      <div className="h-14" aria-hidden="true" />
      <ReaderSkeleton />
    </>
  ) : (
    <PageSkeleton
      page={
        route.view === "models"
          ? route.pricing
            ? "catalog"
            : route.modelKey
              ? "model-detail"
              : "models"
          : route.view
      }
      back={route.view === "models" && !!(route.pricing || route.modelKey)}
    />
  );

  return (
    <WorkspaceContext.Provider value={workspace}>
      <div
        className={cn(
          "grid h-dvh grid-cols-[216px_minmax(0,1fr)] overflow-hidden max-[1100px]:grid-cols-[184px_minmax(0,1fr)]",
          collapsed && "grid-cols-[64px_minmax(0,1fr)] max-[1100px]:grid-cols-[64px_minmax(0,1fr)]",
        )}
      >
        <AppSidebar
          collapsed={collapsed}
          compactWindow={compactWindow}
          view={route.view}
          sessionCount={snapshot.data?.sessionCount}
          agent={agent}
          snapshot={snapshot.data}
          saving={saving}
          onNavigate={navigate}
          onSelectAgent={(id) => {
            setAgent(agent === id ? "all" : id);
            navigate("overview");
          }}
          onSearch={() => setSearchOpen(true)}
          onHelp={() => setHelp(true)}
          onToggleSidebar={() => save({ ...preferences, sidebarCollapsed: !collapsed })}
        />
        <main className="flex min-h-0 min-w-0 flex-col">
          <AppHeader
            scoped={scoped}
            readingSession={readingSession}
            project={project}
            projects={projects}
            agent={agent}
            range={range}
            view={route.view}
            nativeApp={nativeApp}
            syncing={sync.isPending}
            scanning={snapshot.data?.scanning}
            snapshotError={!!snapshot.error}
            onProject={setProject}
            onAgent={setAgent}
            onRange={setRange}
            onSync={() => sync.mutate()}
          />
          <div
            ref={scroll}
            data-slot="page-scroll"
            className={cn(
              "min-h-0 flex-1 overflow-x-auto overflow-y-scroll [overflow-anchor:none] px-9 pb-12 scrollbar-gutter-stable max-[1100px]:px-6 max-[800px]:px-4",
              !readingSession && "pt-6",
            )}
          >
            <div className="mx-auto max-w-362.5">
              {preferenceError && (
                <ErrorNotice error={preferenceError} retry={() => void refetchPreferences()} />
              )}
              {snapshot.error && (
                <ErrorNotice error={snapshot.error} retry={() => void snapshot.refetch()} />
              )}
              {catalog.error && (
                <ErrorNotice error={catalog.error} retry={() => void catalog.refetch()} />
              )}
              {catalog.data?.warning && (
                <ErrorNotice
                  error={new AppFailure(catalog.data.warning)}
                  retry={() => void catalog.refetch()}
                />
              )}
              {!!issues.length && route.view !== "connections" && (
                <button
                  className="mb-5 w-full rounded-lg bg-warning/10 px-4 py-3 text-left text-xs text-warning"
                  onClick={() => navigate("connections")}
                >
                  {issues.length} source {issues.length === 1 ? "needs" : "need"} attention. Totals
                  may be incomplete. Review connections.
                </button>
              )}
              {!nativeApp ? (
                <Empty title="Open Overwatch on your desktop">
                  Local agent histories are available in the Tauri application. Start it with{" "}
                  <code className="font-mono">vp run tauri dev</code>.
                </Empty>
              ) : snapshot.isPending ? (
                loading
              ) : (
                <ErrorBoundary key={route.view}>
                  <Suspense fallback={loading}>
                    {route.view === "overview" && (
                      <Overview
                        scope={scope}
                        sessionCount={snapshot.data?.sessionCount ?? 0}
                        scanning={snapshot.data?.scanning ?? false}
                        detectedSources={
                          snapshot.data?.sources.filter(
                            (source) => source.source.enabled && source.available,
                          ).length ?? 0
                        }
                        range={Number(range)}
                        now={now}
                        openSession={openSession}
                        openDay={(day) => {
                          change(
                            (previous) => ({
                              ...previous,
                              route: { view: "sessions", day },
                              sessions: { ...initialWorkspace.sessions },
                            }),
                            true,
                          );
                          scroll.current?.scrollTo({ top: 0 });
                        }}
                        openModel={(modelKey) => {
                          setRoute({ view: "models", modelKey });
                          scroll.current?.scrollTo({ top: 0 });
                        }}
                        openTool={(tool) => {
                          change(
                            (previous) => ({
                              ...previous,
                              route: { view: "sessions", tool },
                              sessions: { ...initialWorkspace.sessions },
                            }),
                            true,
                          );
                          scroll.current?.scrollTo({ top: 0 });
                        }}
                        clearScope={() => {
                          setProject("all");
                          setAgent("all");
                        }}
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
                        offerings={snapshot.data?.offerings ?? []}
                        range={Number(range)}
                        now={now}
                        scrollRef={scroll}
                      />
                    )}
                    {route.view === "subscriptions" && <Subscriptions now={now} />}
                    {route.view === "connections" && (
                      <Connections
                        sources={snapshot.data?.sources ?? []}
                        openSubscriptions={() => navigate("subscriptions")}
                      />
                    )}
                  </Suspense>
                </ErrorBoundary>
              )}
            </div>
          </div>
        </main>
      </div>
      {searchOpen && (
        <CommandMenu
          pages={navigation.map((page) => ({ label: page.label, select: () => navigate(page.id) }))}
          openSession={(id) => {
            setProject("all");
            setAgent("all");
            openSession(id, sessionQuery());
          }}
          seeAll={(search) => {
            setProject("all");
            setAgent("all");
            change(
              (previous) => ({
                ...previous,
                route: { view: "sessions" },
                sessions: { ...initialWorkspace.sessions, search },
              }),
              true,
            );
            scroll.current?.scrollTo({ top: 0 });
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}
      <Modal
        title="Keyboard shortcuts"
        description="Move through Overwatch without leaving the keyboard."
        open={help}
        onOpenChange={setHelp}
      >
        <dl className="space-y-5 text-sm">
          <div className="flex justify-between">
            <dt>Search pages and sessions</dt>
            <dd>
              <kbd>⌘ / Ctrl K</kbd>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Switch views</dt>
            <dd>
              <kbd>⌘ / Ctrl 1–{navigation.length}</kbd>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Navigate session timeline</dt>
            <dd>
              <kbd>← → Home End</kbd>
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Close dialog</dt>
            <dd>
              <kbd>Esc</kbd>
            </dd>
          </div>
        </dl>
      </Modal>
      <Toaster theme={preferences.theme} position="bottom-right" closeButton richColors />
    </WorkspaceContext.Provider>
  );
}
