<script lang="ts">
  /**
   * Usage across a period as a row of small bars, for seeing at a glance
   * whether something is being used more or less. Quiet columns stay empty
   * above a hairline, so gaps read as gaps.
   */
  interface Props {
    values: readonly number[];
    /** What the bars show, for assistive technology. */
    label: string;
  }

  let { values, label }: Props = $props();

  const WIDTH = 96;
  const HEIGHT = 20;

  const largest = $derived(Math.max(0, ...values));
  const band = $derived(WIDTH / Math.max(1, values.length));
</script>

<svg class="block" width={WIDTH} height={HEIGHT} role="img" aria-label={label}>
  <line class="stroke-border" x1={0} x2={WIDTH} y1={HEIGHT - 0.5} y2={HEIGHT - 0.5} />
  {#each values as value, index (index)}
    {#if value > 0}
      {@const height = Math.max(2, (value / largest) * HEIGHT)}
      <rect
        class="fill-muted"
        x={index * band}
        y={HEIGHT - height}
        width={Math.max(1, band - 1)}
        {height}
      />
    {/if}
  {/each}
</svg>
