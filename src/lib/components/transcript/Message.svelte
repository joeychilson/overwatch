<script lang="ts">
  /**
   * Something the person or the model said.
   *
   * A slash command is something the person did rather than said, so it reads
   * as one line. Each message carries its time, and its day as well when that
   * changed since the message before.
   */
  import type { Turn } from "#lib/api/backend.ts";
  import Markdown from "#lib/components/markdown/Markdown.svelte";
  import { formatDateTime, formatDay, formatTime } from "#lib/format.ts";

  interface Props {
    turn: Turn;
    /** Who the model's turns are attributed to, such as `Codex`. */
    agent: string;
    /** Whether it is the first message on its day. */
    dated: boolean;
    /** Whether the timeline last brought it into view. */
    revealed: boolean;
  }

  let { turn, agent, dated, revealed }: Props = $props();

  const person = $derived(turn.speaker === "user");
  // A command's name has no further slash, which tells it from a path.
  const command = $derived(person && /^\/[\w:-]+(?: .*)?$/.test(turn.text.trim()));
</script>

{#if command}
  <p
    id="turn-{turn.index}"
    class="scroll-mt-24 rounded-control px-1 font-mono text-meta {revealed
      ? 'text-text'
      : 'text-muted'}"
  >
    {turn.text.trim()}
  </p>
{:else}
  <article
    id="turn-{turn.index}"
    class="min-w-0 scroll-mt-24 rounded-menu {person ? 'bg-sidebar px-4 py-3' : 'px-1'} {revealed
      ? 'outline-2 outline-offset-4 outline-(--focus)'
      : ''}"
  >
    <header class="flex items-baseline gap-2">
      <span class="text-meta font-medium" title={turn.model ?? undefined}>
        {person ? "You" : agent}
      </span>
      {#if turn.at !== null}
        <time class="text-label text-muted" title={formatDateTime(turn.at)}>
          {dated ? `${formatDay(turn.at)}, ${formatTime(turn.at)}` : formatTime(turn.at)}
        </time>
      {/if}
    </header>
    <div class="mt-1.5 leading-relaxed">
      <Markdown text={turn.text} />
    </div>
  </article>
{/if}
