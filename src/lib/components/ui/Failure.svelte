<script lang="ts">
  /** A read that failed: what could not be done, why, and a way to try again. */
  import { errorLine } from "#lib/errors.ts";

  interface Props {
    /** What could not be done; without one, the reason stands alone. */
    title?: string;
    error: unknown;
    onretry: () => void;
    retry?: string;
    class?: string;
  }

  let { title, error, onretry, retry = "Retry", class: className = "" }: Props = $props();
</script>

<div class="grid justify-items-start gap-3 {className}">
  {#if title}<p role="alert">{title}</p>{/if}
  <code class="text-meta text-muted" role={title ? undefined : "alert"}>{errorLine(error)}</code>
  <button class="h-9 rounded-control bg-active px-3" onclick={onretry}>{retry}</button>
</div>
