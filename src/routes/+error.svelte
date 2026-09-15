<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import PageHeader, { pageIcon } from "#lib/components/ui/PageHeader.svelte";
</script>

<svelte:head><title>Unable to open page · Overwatch</title></svelte:head>

<div role="alert">
  <PageHeader
    title="Unable to open this page."
    description={page.error?.message ?? "An unexpected error occurred."}
  >
    {#snippet icon()}<TriangleAlert {...pageIcon} />{/snippet}
  </PageHeader>
</div>
<a class="underline underline-offset-4" href={resolve("/")}>Back to Overview</a>
