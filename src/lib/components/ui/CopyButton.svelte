<script lang="ts">
  /**
   * A button that copies something, and says whether it did.
   *
   * The outcome shows as its icon for a moment, and as its name, so assistive
   * technology hears it too; a failure says why. What it copies may take a
   * moment to assemble, so a function is asked for it within the click.
   */
  import { onDestroy } from "svelte";
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { copyText } from "#lib/clipboard.ts";
  import { errorLine } from "#lib/errors.ts";

  interface Props {
    /** What to copy, or how to assemble it. */
    text: string | (() => Promise<string>);
    /** What it copies, such as `Copy message`: its name and its tooltip. */
    label: string;
    /** The icon it shows until it has copied. */
    icon?: typeof Copy;
    size?: number;
    /** Its box, placement and backgrounds, which suit where it sits. */
    class?: string;
  }

  let { text, label, icon: Icon = Copy, size = 14, class: className = "" }: Props = $props();

  /** How long an outcome shows before the button reads as itself again. */
  const SHOWN_MS = 1500;

  let outcome = $state<{ copied: true } | { copied: false; reason: string } | null>(null);
  let clearing: ReturnType<typeof setTimeout> | undefined;

  const name = $derived(
    outcome === null ? label : outcome.copied ? "Copied" : `Could not copy: ${outcome.reason}`,
  );

  async function copy() {
    clearTimeout(clearing);
    outcome = null;
    try {
      await copyText(typeof text === "string" ? text : text());
      outcome = { copied: true };
    } catch (error) {
      outcome = { copied: false, reason: errorLine(error) };
    }
    clearing = setTimeout(() => (outcome = null), SHOWN_MS);
  }

  onDestroy(() => clearTimeout(clearing));
</script>

<button
  type="button"
  class="grid shrink-0 place-items-center rounded-item text-muted hover:text-text {className}"
  title={name}
  aria-label={name}
  onclick={copy}
>
  {#if outcome === null}
    <Icon {size} aria-hidden="true" />
  {:else if outcome.copied}
    <Check {size} aria-hidden="true" />
  {:else}
    <TriangleAlert class="text-danger" {size} aria-hidden="true" />
  {/if}
</button>
