<script module lang="ts">
  /** Size and weight of the icon a page's title carries. */
  export const pageIcon = { size: 22, strokeWidth: 1.65 } as const;
</script>

<script lang="ts">
  /**
   * The title block every page opens with, in one shape on every page, so that
   * moving between pages moves nothing.
   *
   * An icon and the title stand level with the page's controls, and one line of
   * information sits beneath the title. That line keeps its height with nothing
   * in it, such as while a page reads, and truncates rather than wraps, so what
   * follows the header starts in the same place on each page. Each screen owns
   * exactly one, so the level is fixed at `h1`.
   */
  import type { Snippet } from "svelte";
  import type { Attachment } from "svelte/attachments";

  interface Props {
    title: string;
    /** The page's icon at `pageIcon`'s size, or a mark of about that size. */
    icon: Snippet;
    /** One line of plain text about what the page shows. */
    description?: string;
    /** Controls such as the period a page shows, at the far end of the title. */
    actions?: Snippet;
  }

  let { title, icon, description, actions }: Props = $props();

  /**
   * Give an element its text as a tooltip while the text is cut off, and none
   * while it fits, so hovering reveals only what the header had to hide.
   */
  function tooltipWhenCut(text: string | undefined): Attachment<HTMLElement> {
    return (element) => {
      const observer = new ResizeObserver(() => {
        if (text && element.scrollWidth > element.clientWidth) element.title = text;
        else element.removeAttribute("title");
      });
      observer.observe(element);
      return () => observer.disconnect();
    };
  }
</script>

<header class="mb-6 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
  <!-- Its basis ignores its text, so a long title or line truncates instead of
       pushing the controls onto a line of their own. -->
  <div class="min-w-0 flex-[1_1_16rem]">
    <div class="flex h-9 items-center gap-3">
      <span class="flex size-6 shrink-0 items-center justify-center text-muted" aria-hidden="true">
        {@render icon()}
      </span>
      <h1 class="truncate text-title" {@attach tooltipWhenCut(title)}>{title}</h1>
    </div>
    <p class="h-lh truncate pl-9 text-muted" {@attach tooltipWhenCut(description)}>
      {description}
    </p>
  </div>
  {#if actions}
    <div class="flex h-9 shrink-0 items-center gap-2">{@render actions()}</div>
  {/if}
</header>
