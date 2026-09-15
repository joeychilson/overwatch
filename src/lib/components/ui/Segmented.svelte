<script lang="ts" generics="T">
  /** A row of choices, the chosen one shown pressed. */
  interface Props {
    options: readonly { value: T; label: string }[];
    /** Unset while no option describes what is shown, so none is pressed. */
    value: T | undefined;
    onchange: (value: T) => void;
  }

  let { options, value, onchange }: Props = $props();
</script>

<div class="flex h-9 shrink-0 items-center rounded-control border border-border p-0.5">
  {#each options as option (option.label)}
    <button
      class="h-full rounded-[5px] px-2.5 {value === option.value
        ? 'bg-active text-text'
        : 'text-muted hover:text-text'}"
      aria-pressed={value === option.value}
      onclick={() => onchange(option.value)}
    >
      {option.label}
    </button>
  {/each}
</div>
