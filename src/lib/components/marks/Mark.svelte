<script lang="ts">
  /**
   * One brand mark drawn in the current text colour.
   *
   * The mark is decorative on its own: whatever names the thing it stands for,
   * usually a nearby label, carries the accessible name. Pass `label` only when
   * the mark appears without one.
   */
  import { MARKS, type MarkName } from "./marks.ts";

  interface Props {
    name: MarkName;
    /** Edge length in pixels. */
    size?: number;
    /** Accessible name, when no adjacent text names the same thing. */
    label?: string;
    class?: string;
  }

  let { name, size = 20, label, class: className = "" }: Props = $props();

  const mark = $derived(MARKS[name]);
  // An inset mark keeps its own proportions and is centred in the same box, so
  // marks of different visual weight sit on one optical line.
  const inset = $derived(mark.scale === undefined ? "" : `scale(${mark.scale})`);
</script>

<svg
  class={className}
  width={size}
  height={size}
  viewBox={mark.viewBox}
  fill="currentColor"
  role={label ? "img" : "presentation"}
  aria-label={label}
  aria-hidden={label ? undefined : "true"}
>
  <g transform-origin="center" transform={inset}>
    {#each mark.paths as path, index (index)}
      <path d={path.d} fill-rule={path.evenOdd ? "evenodd" : undefined} />
    {/each}
  </g>
</svg>
