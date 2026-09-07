import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { Toaster } from "sonner";
import { commands, type Agent, type SessionQuery } from "@/lib/bindings";
import { historyOptions, historyScope, sessionQuery } from "@/lib/history";
import { AppFailure, native } from "@/lib/errors";
import { catalogOptions } from "@/lib/queries";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { useNativeEvents } from "@/lib/hooks/use-native-events";
import { useNow } from "@/lib/hooks/use-now";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { navigation, type View } from "@/lib/shell/navigation";
import { cn } from "cn";
import { AppHeader } from "@/lib/shell/header";
import { AppSidebar } from "@/lib/shell/sidebar";
import { Skeleton } from "@/lib/components/ui/skeleton";
import { Empty, ErrorNotice, Modal } from "@/lib/components/page";
import { CommandMenu } from "@/lib/components/command-menu";
import { ErrorBoundary } from "@/lib/components/error-boundary";

const Overview = lazy(() => import("@/pages/overview"));
const Sessions = lazy(() => import("@/pages/sessions"));
const Models = lazy(() => import("@/pages/models"));
const Subscriptions = lazy(() => import("@/pages/subscriptions"));
const Connections = lazy(() => import("@/pages/connections"));

type Route =
  | { view: Exclude<View, "sessions" | "models"> }
  | { view: "models"; modelKey?: string }
  | {
      view: "sessions";
      id?: string;
      query?: SessionQuery;
      day?: string;
      tool?: string;
      search?: string;
    };

export default function App() {
  const [route, setRoute] = useState<Route>({ view: "overview" });
  const [modelsVisit, setModelsVisit] = useState(0);
  const [agent, setAgent] = useState<Agent | "all">("all");
  const [project, setProject] = useState("all");
  const [range, setRange] = useState("30");
  const [searchOpen, setSearchOpen] = useState(false);
  const [help, setHelp] = useState(false);
  const compactWindow = useMediaQuery("(max-width: 799px)");
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");
  const scroll = useRef<HTMLDivElement>(null);
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
        if (item.id === "models") setModelsVisit((visit) => visit + 1);
        setRoute({ view: item.id });
        scroll.current?.scrollTo({ top: 0 });
      }
    };
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("keydown", key);
    };
  }, []);

  const scope = historyScope({
    project: project === "all" ? null : project,
    agent: agent === "all" ? null : agent,
  });
  const projects = snapshot.data?.projects ?? [];

  const navigate = (view: View) => {
    if (view === "models") setModelsVisit((visit) => visit + 1);
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

  return (
    <>
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
                <div className="space-y-6">
                  <Skeleton className="h-10 w-48" />
                  <Skeleton className="h-28 w-full" />
                  <Skeleton className="h-72 w-full" />
                </div>
              ) : (
                <ErrorBoundary key={route.view}>
                  <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
                    {route.view === "overview" && (
                      <Overview
                        scope={scope}
                        sessionCount={snapshot.data?.sessionCount ?? 0}
                        range={Number(range)}
                        now={now}
                        openSession={openSession}
                        openDay={(day) => {
                          setRoute({ view: "sessions", day });
                          scroll.current?.scrollTo({ top: 0 });
                        }}
                        openModel={(modelKey) => {
                          setModelsVisit((visit) => visit + 1);
                          setRoute({ view: "models", modelKey });
                          scroll.current?.scrollTo({ top: 0 });
                        }}
                        openTool={(tool) => {
                          setRoute({ view: "sessions", tool });
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
                        key={`${scope.agent}:${scope.project}:${route.search ?? ""}`}
                        scope={scope}
                        initialSearch={route.search}
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
                        key={modelsVisit}
                        initialModelKey={route.modelKey}
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
            setRoute({ view: "sessions", search });
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
    </>
  );
}
