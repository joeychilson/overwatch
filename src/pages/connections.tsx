import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, RefreshCw } from "lucide-react";
import { agents } from "@/lib/agents";
import { commands, type Source, type SourcePreview, type SourceStatus } from "@/lib/bindings";
import { native } from "@/lib/errors";
import { historyOptions } from "@/lib/history";
import { accountOptions } from "@/lib/queries";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { AgentMark } from "@/lib/components/agent-mark";
import { Button } from "@/lib/components/ui/button";
import { Input } from "@/lib/components/ui/input";
import { Switch } from "@/lib/components/ui/switch";
import { ErrorNotice, Modal, PageTitle, Section } from "@/lib/components/page";

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
  const [pending, setPending] = useState<SourcePreview | null>(null);
  const save = useMutation({
    mutationFn: (preview: SourcePreview) => native(commands.saveSourcePreview(preview)),
    onSuccess: async () => {
      setPending(null);
      await Promise.all([
        client.invalidateQueries(historyOptions),
        client.invalidateQueries(accountOptions),
      ]);
    },
  });
  const preview = useMutation({
    mutationFn: (source: Source) => native(commands.previewSource(source)),
    onSuccess: (result) => {
      save.reset();
      if (
        result.sessions ||
        result.allowanceSamples ||
        result.account ||
        (result.source.enabled && result.issues.length)
      ) {
        setPending(result);
      } else {
        save.mutate(result);
      }
    },
  });
  const refresh = useMutation({
    mutationFn: () => native(commands.refreshHistory()),
    onSuccess: (snapshot) => client.setQueryData(historyOptions.queryKey, snapshot),
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
              busy={save.isPending || preview.isPending}
              save={preview.mutate}
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
      <Modal
        open={!!pending}
        onOpenChange={(open) => {
          if (!open && !save.isPending) setPending(null);
        }}
        title={
          pending ? `Change ${agents[pending.source.agent].name} folder?` : "Change source folder?"
        }
        description="Review this change before saving."
      >
        {pending && (
          <>
            <dl className="space-y-3 text-xs">
              <div>
                <dt className="mb-1 text-muted-foreground">Current folder</dt>
                <dd className="font-mono break-all">{pending.current.path}</dd>
              </div>
              <div>
                <dt className="mb-1 text-muted-foreground">New folder</dt>
                <dd className="font-mono break-all">{pending.source.path}</dd>
              </div>
            </dl>
            {(pending.sessions > 0 || pending.allowanceSamples > 0 || pending.account) && (
              <div className="space-y-2 rounded-lg bg-muted p-4 text-sm">
                {pending.sessions > 0 && (
                  <p>
                    {pending.sessions.toLocaleString()} cached sessions will be replaced by history
                    from the new folder.
                  </p>
                )}
                {pending.allowanceSamples > 0 && (
                  <p>
                    {pending.allowanceSamples.toLocaleString()} saved allowance readings will be
                    cleared. Rescanning cannot recover these readings.
                  </p>
                )}
                {pending.account && (
                  <p>The saved account reading will be refreshed from the new folder’s sign-in.</p>
                )}
              </div>
            )}
            {pending.issues.map((issue) => (
              <p key={issue} className="text-xs leading-relaxed text-warning">
                {issue}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              Original history files will stay untouched.
            </p>
            {save.error && (
              <ErrorNotice error={save.error} retry={() => preview.mutate(pending.source)} />
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={save.isPending} onClick={() => setPending(null)}>
                Cancel
              </Button>
              <Button
                disabled={save.isPending || preview.isPending || !!save.error}
                onClick={() => save.mutate(pending)}
              >
                Change folder
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
