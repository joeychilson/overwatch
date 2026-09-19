<script lang="ts">
  /** One thing the session list is narrowed to, which clears when chosen. */
  import type { Snippet } from "svelte";
  import X from "@lucide/svelte/icons/x";

  interface Props {
    /** The list without it. */
    href: string;
    /** What choosing it does, such as `Show every project, not only demo`. */
    label: string;
    title?: string;
    children: Snippet;
  }

  let { href, label, title, children }: Props = $props();
</script>

<a
  class="flex h-9 min-w-0 shrink-0 items-center gap-2 rounded-control border border-border pr-2 pl-2.5 hover:bg-hover"
  {href}
  {title}
  aria-label={label}
>
  {@render children()}
  <X class="shrink-0 text-muted" size={14} aria-hidden="true" />
</a>
