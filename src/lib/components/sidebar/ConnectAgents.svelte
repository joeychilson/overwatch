<script lang="ts">
  /**
   * The way to connect an agent to Overwatch's MCP server: pick the agent, and
   * copy the command that registers the server with it, or the configuration
   * that does. Overwatch writes nothing of an agent's itself.
   */
  import { Dialog } from "bits-ui";
  import Plug from "@lucide/svelte/icons/plug";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";
  import CopyButton from "#lib/components/ui/CopyButton.svelte";
  import Failure from "#lib/components/ui/Failure.svelte";
  import Segmented from "#lib/components/ui/Segmented.svelte";
  import { agentName } from "#lib/agents.ts";
  import { getMcpServer } from "#lib/api/backend.ts";
  import { CLIENTS, isClient, isTranslocated, steps, type Client } from "#lib/connect.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { sidebarIcon, sidebarItem } from "./item.ts";

  const engine = getEngine();

  const options = CLIENTS.map((client) => ({
    value: client,
    label: client === "other" ? "Other" : agentName(client),
  }));

  /** The client the reader picked, or none while the choice follows the agents found here. */
  let picked = $state<Client | null>(null);
  const client = $derived<Client>(picked ?? engine.status.agents.find(isClient) ?? "claude_code");
</script>

<Dialog.Root>
  <Dialog.Trigger class="{sidebarItem} data-[state=open]:bg-hover data-[state=open]:text-text">
    <Plug class="shrink-0" {...sidebarIcon} aria-hidden="true" />
    <span>Connect agents</span>
  </Dialog.Trigger>

  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-3rem)] w-[min(38rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-menu border border-border bg-menu p-5 shadow-[0_24px_60px_#00000033,0_2px_8px_#00000014]"
    >
      <div class="flex items-start justify-between gap-4">
        <div class="min-w-0">
          <Dialog.Title class="text-section">Connect an agent</Dialog.Title>
          <Dialog.Description class="text-meta text-muted">
            Let your agents ask Overwatch about your sessions, usage and limits.
          </Dialog.Description>
        </div>
        <Dialog.Close
          class="-m-1 grid size-7 shrink-0 place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
          aria-label="Close"
        >
          <X size={15} aria-hidden="true" />
        </Dialog.Close>
      </div>

      <div class="mt-4 flex" role="group" aria-label="Agent">
        <Segmented {options} value={client} onchange={(next) => (picked = next)} />
      </div>

      <svelte:boundary>
        {#snippet pending()}
          <p class="mt-4 text-meta text-muted">Finding where Overwatch is…</p>
          <div class="mt-2 h-17 animate-pulse rounded-control bg-hover" aria-hidden="true"></div>
        {/snippet}

        {#snippet failed(error, reset)}
          <Failure
            class="mt-4"
            title="Could not find where Overwatch is."
            {error}
            onretry={reset}
          />
        {/snippet}

        {@const server = await getMcpServer()}
        {#if isTranslocated(server.command)}
          <p class="mt-4 flex gap-2 text-meta" role="alert">
            <TriangleAlert class="mt-0.5 shrink-0 text-warning" size={14} aria-hidden="true" />
            <span>
              macOS is running Overwatch from a temporary copy, so this would stop working. Move
              Overwatch to Applications, open it from there, and connect again.
            </span>
          </p>
        {/if}
        {#each steps(client, server) as step (step.code)}
          <p class="mt-4 text-meta text-muted">{step.say}</p>
          <div class="mt-2 flex items-start gap-2 rounded-control bg-hover py-2.5 pr-2 pl-3">
            <code
              class="min-w-0 flex-1 py-0.5 font-mono text-meta whitespace-pre-wrap select-text wrap-anywhere"
              >{step.code}</code
            >
            <CopyButton
              text={step.code}
              label="Copy {step.kind}"
              class="h-6 gap-1.5 px-1.5 hover:bg-active"
            >
              {#snippet children(copied)}
                <!-- Both words hold the space, so confirming the copy moves nothing. -->
                <span class="grid text-meta">
                  <span class={["col-start-1 row-start-1", { invisible: copied }]}>Copy</span>
                  <span class={["col-start-1 row-start-1", { invisible: !copied }]}>Copied</span>
                </span>
              {/snippet}
            </CopyButton>
          </div>
        {/each}
      </svelte:boundary>

      <p class="mt-4 text-meta text-muted">
        Agents can only read. They see what Overwatch has indexed, which it keeps current while it
        runs.
      </p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
