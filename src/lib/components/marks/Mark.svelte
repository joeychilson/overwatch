<script lang="ts">
  /**
   * One brand mark drawn in the current text colour. It is decorative: the
   * name of what it stands for is always written beside it.
   */
  import { MARKS, type MarkName } from "./marks.ts";

  interface Props {
    name: MarkName;
    /** Edge length in pixels. */
    size?: number;
    class?: string;
  }

  let { name, size = 20, class: className = "" }: Props = $props();

  const mark = $derived(MARKS[name]);
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox={mark.viewBox}
  fill="currentColor"
  aria-hidden="true"
>
  <!-- An inset mark keeps its proportions, centred in the same box, so marks of
       different visual weight sit on one optical line. -->
  <g transform-origin="center" transform={mark.scale === undefined ? "" : `scale(${mark.scale})`}>
    {#each mark.paths as path (path.d)}
      <path d={path.d} fill-rule={path.evenOdd ? "evenodd" : undefined} />
    {/each}
  </g>
</svg>
