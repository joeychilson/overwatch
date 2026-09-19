<script lang="ts">
  /**
   * What a view shows when there is nothing in it: what is missing, and what
   * would fill it. It stands where the view's content would, so a page keeps
   * its shape with or without data.
   */
  import type Inbox from "@lucide/svelte/icons/inbox";

  interface Props {
    icon: typeof Inbox;
    title: string;
    description?: string;
    class?: string;
  }

  let { icon: Icon, title, description, class: className = "" }: Props = $props();
</script>

<div
  class="flex flex-col items-center justify-center gap-1 rounded-menu border border-dashed border-border px-6 py-8 text-center {className}"
>
  <Icon class="mb-1.5 text-muted" size={18} aria-hidden="true" />
  <p class="font-medium">{title}</p>
  {#if description}
    <p class="max-w-md text-meta text-muted">{description}</p>
  {/if}
</div>
