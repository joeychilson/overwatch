<script lang="ts">
  /**
   * One step towards a reply: a tool call, or recorded thinking.
   *
   * Closed, a call says what it was about — the command, the file, the query —
   * and whether it failed, so a run of them reads without opening any. Its
   * arguments and result arrive with it, so opening one makes no request.
   */
  import Bot from "@lucide/svelte/icons/bot";
  import Brain from "@lucide/svelte/icons/brain";
  import FilePen from "@lucide/svelte/icons/file-pen";
  import FileText from "@lucide/svelte/icons/file-text";
  import Globe from "@lucide/svelte/icons/globe";
  import Search from "@lucide/svelte/icons/search";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import Wrench from "@lucide/svelte/icons/wrench";
  import type { Turn } from "#lib/api/backend.ts";
  import Markdown from "#lib/components/markdown/Markdown.svelte";
  import { firstLine, toolKind, toolSubject, type ToolKind } from "#lib/transcript.ts";

  interface Props {
    turn: Turn;
    /** Whether the timeline last brought it into view. */
    revealed: boolean;
  }

  let { turn, revealed }: Props = $props();

  const ICONS: Record<ToolKind, typeof Wrench> = {
    command: SquareTerminal,
    edit: FilePen,
    read: FileText,
    search: Search,
    web: Globe,
    agent: Bot,
    other: Wrench,
  };

  let open = $state(false);

  const tool = $derived(turn.tool);
  const Icon = $derived(tool ? ICONS[toolKind(tool.name)] : Brain);
  const subject = $derived(tool ? toolSubject(tool) : firstLine(turn.text));

  /**
   * Arguments as something readable: a JSON object pretty printed, and
   * anything else exactly as it was recorded.
   */
  const input = $derived.by(() => {
    const raw = tool?.input.trim() ?? "";
    if (raw === "") return null;
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  });
</script>

<div
  id="turn-{turn.index}"
  class="min-w-0 scroll-mt-24 rounded-control {revealed ? 'bg-hover' : ''}"
>
  <button
    class="flex w-full min-w-0 items-center gap-2 rounded-control px-2 py-1 text-left text-meta hover:bg-hover"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    <Icon class="shrink-0 text-muted" size={14} aria-hidden="true" />
    <span class="shrink-0">{tool?.name ?? "Thinking"}</span>
    <span class="min-w-0 truncate text-muted {tool ? 'font-mono' : ''}">{subject}</span>
    {#if tool?.failed}
      <span class="ml-auto shrink-0 text-danger">Failed</span>
    {/if}
  </button>

  {#if open}
    <div class="grid min-w-0 gap-1 px-2 pt-1 pb-3">
      {#if tool}
        {#if input !== null}
          <p class="text-label text-muted">Input</p>
          <pre
            class="max-h-80 overflow-auto rounded-item bg-hover p-2 font-mono text-meta wrap-anywhere whitespace-pre-wrap">{input}</pre>
        {/if}
        {#if tool.output}
          <p class="mt-1 text-label text-muted">Output</p>
          <pre
            class="max-h-96 overflow-auto rounded-item bg-hover p-2 font-mono text-meta wrap-anywhere whitespace-pre-wrap">{tool.output}</pre>
        {:else}
          <p class="mt-1 text-meta text-muted">No result was recorded.</p>
        {/if}
      {:else}
        <div class="text-muted"><Markdown text={turn.text} /></div>
      {/if}
    </div>
  {/if}
</div>
