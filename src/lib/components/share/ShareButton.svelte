<script lang="ts">
  /**
   * The picture of a period, and the control beside the overview's own that
   * offers it.
   *
   * Drawing a card is synchronisation with something outside Svelte, so it
   * happens in an effect: the canvas is redrawn whenever what the card says or
   * the palette it is set in changes. The card is set in Inter, which the page
   * behind the dialog has long since loaded, but the first draw waits for the
   * document's fonts rather than assume it.
   *
   * Saving hands the picture to the engine, which writes it to the Desktop.
   * There is no share sheet behind a desktop window and nowhere to drag a
   * canvas to, so leaving a file where the reader will find it is the whole of
   * it; where it went is reported rather than opened, because a window jumping
   * to Finder is not what was asked for.
   */
  import { onMount } from "svelte";
  import { Dialog } from "bits-ui";
  import Download from "@lucide/svelte/icons/download";
  import Share2 from "@lucide/svelte/icons/share-2";
  import X from "@lucide/svelte/icons/x";
  import { mode } from "mode-watcher";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import { saveCard } from "#lib/api/backend.ts";
  import { HEIGHT, WIDTH, draw, type Card, type Theme } from "#lib/card.ts";
  import { errorLine } from "#lib/errors.ts";
  import { formatProject } from "#lib/format.ts";

  interface Props {
    /** What to draw, or nothing while the period is still being read. */
    card: Card | undefined;
  }

  let { card }: Props = $props();

  const THEMES: readonly { value: Theme; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  let canvas = $state<HTMLCanvasElement | null>(null);
  /** The palette the reader picked, or none while the card follows the window. */
  let picked = $state<Theme | null>(null);
  /** Whether the document's fonts have arrived, so the card is set in Inter. */
  let lettered = $state(false);
  let saving = $state(false);
  /** Where the last card went, and why the last save failed. */
  let saved = $state<string | null>(null);
  let problem = $state<string | null>(null);

  const theme = $derived<Theme>(picked ?? (mode.current === "dark" ? "dark" : "light"));

  /** The card read out, for anyone who cannot see it. */
  const described = $derived(
    card === undefined
      ? "Your usage as a picture"
      : [
          `${card.period}.`,
          ...card.figures.map((figure) => `${figure.label}: ${figure.value}.`),
          card.line,
        ].join(" "),
  );

  onMount(() => {
    void document.fonts.ready.then(() => (lettered = true));
  });

  $effect(() => {
    if (canvas === null || card === undefined || !lettered) return;
    draw(canvas, card, theme);
  });

  /** Nothing said about the last save is true of the next one. */
  function reset() {
    saved = null;
    problem = null;
  }

  async function save() {
    if (canvas === null || card === undefined) return;
    saving = true;
    problem = null;
    try {
      // The canvas hands over a data URL; the engine writes the base64 after
      // its comma.
      const png = canvas.toDataURL("image/png").split(",")[1] ?? "";
      saved = await saveCard(card.name, png);
    } catch (error) {
      saved = null;
      problem = errorLine(error);
    } finally {
      saving = false;
    }
  }
</script>

<Dialog.Root onOpenChange={(opening) => opening && reset()}>
  <Dialog.Trigger
    class="grid aspect-square h-9 shrink-0 place-items-center rounded-control border border-border text-muted hover:text-text disabled:pointer-events-none disabled:opacity-40"
    disabled={card === undefined}
    title="Share this period"
    aria-label="Share this period"
  >
    <Share2 size={15} aria-hidden="true" />
  </Dialog.Trigger>

  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 w-[min(46rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 rounded-menu border border-border bg-menu p-5 shadow-[0_24px_60px_#00000033,0_2px_8px_#00000014]"
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <Dialog.Title class="text-section">Share your usage</Dialog.Title>
          <Dialog.Description class="truncate text-meta text-muted">
            {card === undefined
              ? ""
              : [card.period, card.range].filter((part) => part !== "").join(" · ")}
          </Dialog.Description>
        </div>
        <Dialog.Close
          class="-m-1 grid size-7 shrink-0 place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
          aria-label="Close"
        >
          <X size={15} aria-hidden="true" />
        </Dialog.Close>
      </div>

      <!-- The canvas has no accessible name of its own, so the frame it sits in
           carries one and the drawing itself is passed over. -->
      <div
        class="mt-4 overflow-hidden rounded-control border border-border"
        role="img"
        aria-label={described}
      >
        <canvas
          class="block w-full"
          style:aspect-ratio="{WIDTH} / {HEIGHT}"
          bind:this={canvas}
          aria-hidden="true"
        ></canvas>
      </div>

      <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
        <Segmented options={THEMES} value={theme} onchange={(next) => (picked = next)} />
        <button
          class="flex h-9 items-center gap-2 rounded-control bg-active px-3.5 disabled:opacity-50"
          disabled={saving || card === undefined}
          onclick={() => void save()}
        >
          <Download class="shrink-0" size={15} aria-hidden="true" />
          <span>{saving ? "Saving…" : "Save to Desktop"}</span>
        </button>
      </div>

      <!-- The line keeps its height with nothing in it, so saving moves nothing. -->
      <p class="mt-3 h-lh truncate text-meta text-muted" role="status">
        {#if problem !== null}
          <span class="text-danger">{problem}</span>
        {:else if saved !== null}
          Saved · {formatProject(saved, 2)}
        {:else}
          A {WIDTH} × {HEIGHT} PNG, for wherever you post it.
        {/if}
      </p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
