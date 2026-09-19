<script lang="ts">
  /**
   * A button that copies something, and says whether it did: by its icon for a
   * moment, and by its name, so assistive technology hears it too.
   */
  import { onDestroy, type Snippet } from "svelte";
  import Check from "@lucide/svelte/icons/check";
  import Copy from "@lucide/svelte/icons/copy";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import { errorLine } from "#lib/errors.ts";

  interface Props {
    /** What to copy, or how to assemble it. */
    text: string | (() => Promise<string>);
    /** What it copies, such as `Copy message`: its name and, unless `title` says otherwise, its tooltip. */
    label: string;
    title?: string;
    icon?: typeof Copy;
    size?: number;
    /** Words beside the icon, given whether it has just copied. */
    children?: Snippet<[boolean]>;
    class?: string;
  }

  let {
    text,
    label,
    title,
    icon: Icon = Copy,
    size = 14,
    children,
    class: className = "",
  }: Props = $props();

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
      if (typeof text === "string") {
        await navigator.clipboard.writeText(text);
      } else {
        // WebKit takes a write only within the click that asked for it, so text
        // still being assembled is handed over as a promise the clipboard awaits.
        const blob = text().then((value) => new Blob([value], { type: "text/plain" }));
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      }
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
  class="flex shrink-0 items-center justify-center rounded-item text-muted hover:text-text {className}"
  title={outcome === null ? (title ?? label) : name}
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
  {@render children?.(outcome?.copied === true)}
</button>
