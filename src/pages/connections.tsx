import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, RefreshCw } from "lucide-react";
import { agents } from "@/lib/agents";
import { commands, type Source, type SourceStatus } from "@/lib/bindings";
import { native } from "@/lib/errors";
import { accountOptions, snapshotOptions } from "@/lib/queries";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { AgentMark } from "@/lib/components/agent-mark";
import { Button } from "@/lib/components/ui/button";
import { Input } from "@/lib/components/ui/input";
import { Switch } from "@/lib/components/ui/switch";
import { ErrorNotice, PageTitle, Section } from "@/lib/components/page";

function SourceEditor({
  status,
  busy,
  save,
  openSubscriptions,
}: {
  status: SourceStatus;
  busy: boolean;
  save: (source: Source) => void;
  openSubscriptions: () => void;
}) {
  const [draft, setDraft] = useState(status.source);

  const changed = draft.path !== status.source.path || draft.enabled !== status.source.enabled;

  const choose = useMutation({
    mutationFn: () => open({ directory: true, multiple: false, defaultPath: draft.path }),
    onSuccess: (path) => {
      if (path) setDraft({ ...draft, path });
    },
  });

  const supported = status.source.agent !== "antigravity";
  if (!supported)
    return (
      <section className="flex flex-col items-start rounded-xl bg-card p-5">
        <div className="flex items-center gap-3">
          <AgentMark agent={draft.agent} className="size-9" />
          <h3 className="text-sm font-medium">{agents[draft.agent].name}</h3>
        </div>
        <p className="mt-4 text-[11px] text-muted-foreground">
          Subscription quotas are supported. Local history is unavailable.
        </p>
        <Button variant="ghost" size="sm" className="mt-3" onClick={openSubscriptions}>
          View subscriptions
        </Button>
      </section>
    );

  return (
    <section className="rounded-xl bg-card p-5">
      <div className="flex items-start gap-3">
        <AgentMark agent={draft.agent} className="size-9" />
        <div className="flex-1">
          <h3 className="text-sm font-medium">{agents[draft.agent].name}</h3>
          <p className="mt-1 text-[11px] text-muted-foreground">
            {!status.source.enabled
              ? "Source disabled"
              : status.issues.length
                ? "Source needs attention"
                : status.available
                  ? `${status.sessions.toLocaleString()} indexed sessions`
                  : "Folder not found"}
          </p>
        </div>
        <Switch
          aria-label={`Enable ${agents[draft.agent].name} history`}
          checked={draft.enabled}
          disabled={busy}
          onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
        />
      </div>
      <div className="mt-5 flex gap-2">
        <Input
          aria-label={`${agents[draft.agent].name} source folder`}
          value={draft.path}
          disabled={busy}
          className="bg-background/70 font-mono"
          onChange={(event) => setDraft({ ...draft, path: event.target.value })}
        />
        <Button
          variant="outline"
          size="icon"
          aria-label={`Choose ${agents[draft.agent].name} folder`}
          disabled={busy || choose.isPending}
          onClick={() => choose.mutate()}
        >
          <FolderOpen />
        </Button>
      </div>
      {status.issues.map((issue) => (
        <p
          role="status"
          key={issue}
          className="mt-3 text-xs leading-relaxed wrap-break-word text-warning"
        >
          {issue}
        </p>
      ))}
      {changed && (
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(status.source)}>
            Cancel
          </Button>
          <Button size="sm" disabled={busy || !draft.path.trim()} onClick={() => save(draft)}>
            Save source
          </Button>
        </div>
      )}
    </section>
  );
}

export default function Connections({
  sources,
  openSubscriptions,
}: {
  sources: SourceStatus[];
  openSubscriptions: () => void;
}) {
  const client = useQueryClient();
  const preferences = usePreferences();
  const save = useMutation({
    mutationFn: (source: Source) =>
      native(
        commands.saveSources(
          sources.map((status) => (status.source.agent === source.agent ? source : status.source)),
        ),
      ),
    onSuccess: async (snapshot) => {
      client.setQueryData(snapshotOptions.queryKey, snapshot);
      await client.invalidateQueries(accountOptions);
    },
  });
  const refresh = useMutation({
    mutationFn: () => native(commands.refreshIndex()),
    onSuccess: (snapshot) => client.setQueryData(snapshotOptions.queryKey, snapshot),
  });
  return (
    <>
      <PageTitle
        title="Connections"
        action={
          <Button
            variant="outline"
            disabled={refresh.isPending || save.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />
            Rescan sources
          </Button>
        }
      />
      <Section title="Agent history">
        <div className="grid grid-cols-2 gap-4 max-[1100px]:grid-cols-1">
          {sources.map((status) => (
            <SourceEditor
              key={`${status.source.agent}:${status.source.path}:${status.source.enabled}`}
              status={status}
              busy={save.isPending}
              save={save.mutate}
              openSubscriptions={openSubscriptions}
            />
          ))}
        </div>
        <p className="mt-4 text-[11px] leading-relaxed text-muted-foreground">
          Choose an agent’s root folder. Overwatch reads its session subdirectories and opens
          OpenCode’s SQLite database in read-only mode. Disabling a source hides its history without
          changing the original files.
        </p>
      </Section>
      <Section title="Appearance" className="mt-10">
        {preferences.error && (
          <ErrorNotice error={preferences.error} retry={() => void preferences.refetch()} />
        )}
        <div className="flex flex-wrap gap-3">
          {(["dark", "light", "system"] as const).map((theme) => (
            <Button
              key={theme}
              variant={preferences.preferences.theme === theme ? "secondary" : "outline"}
              aria-pressed={preferences.preferences.theme === theme}
              disabled={preferences.saving}
              className="min-w-28 capitalize"
              onClick={() => preferences.save({ ...preferences.preferences, theme })}
            >
              {theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"}
            </Button>
          ))}
        </div>
      </Section>
      <Section title="Local storage" className="mt-10">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Session summaries, quota history, and settings are stored on this device. Saved provider
          credentials live in your operating system’s credential store. Original transcripts are
          read on demand. There is no telemetry or cloud synchronization.
        </p>
      </Section>
    </>
  );
}
