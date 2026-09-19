<script lang="ts">
  /**
   * The way to add Overwatch's MCP server to an agent: pick the agent, and copy
   * the command that registers the server with it, or the configuration that
   * does. Overwatch writes nothing of an agent's itself.
   */
  import { Dialog } from "bits-ui";
  import Blocks from "@lucide/svelte/icons/blocks";
  import Braces from "@lucide/svelte/icons/braces";
  import MessageSquareText from "@lucide/svelte/icons/message-square-text";
  import Plug from "@lucide/svelte/icons/plug";
  import ShieldCheck from "@lucide/svelte/icons/shield-check";
  import SquareTerminal from "@lucide/svelte/icons/square-terminal";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import X from "@lucide/svelte/icons/x";
  import AgentMark from "#lib/components/marks/AgentMark.svelte";
  import CopyButton from "#lib/components/ui/CopyButton.svelte";
  import Failure from "#lib/components/ui/Failure.svelte";
  import { agentName } from "#lib/agents.ts";
  import { getMcpServer } from "#lib/api/backend.ts";
  import {
    CLIENTS,
    instruction,
    isClient,
    isTranslocated,
    step,
    type Client,
  } from "#lib/connect.ts";
  import { getEngine } from "#lib/state/engine.svelte.ts";
  import { sidebarIcon, sidebarItem } from "./item.ts";

  const engine = getEngine();

  /** What to ask once connected, so the reader sees what it is for. */
  const EXAMPLES = [
    "What did I spend on this project this week?",
    "Find the session where we fixed the login redirect.",
    "Keep going, but stop when the 5-hour limit reaches 50%.",
  ];

  /** The client the reader picked, or none while the choice follows the agents found here. */
  let picked = $state<Client | null>(null);
  const client = $derived<Client>(picked ?? engine.status.agents.find(isClient) ?? "claude_code");

  /**
   * Where this app is, owned here rather than in the dialog, whose content is
   * created afresh each time it opens: a running executable cannot move, so it
   * is asked once, as the sidebar appears, and each opening shows the step at
   * once instead of flashing the pending state. Retry asks again.
   */
  let server = $state.raw(locate());

  function locate() {
    const found = getMcpServer();
    // Nothing awaits it until the dialog opens, which reports a failure then.
    found.catch(() => undefined);
    return found;
  }

  function label(client: Client): string {
    return client === "other" ? "Other" : agentName(client);
  }
</script>

{#snippet clientMark(client: Client, size: number)}
  {#if client === "other"}
    <Blocks {size} strokeWidth={1.75} aria-hidden="true" />
  {:else}
    <AgentMark agent={client} {size} />
  {/if}
{/snippet}

{#snippet heading(number: number, text: string)}
  <h3 class="flex items-center gap-2.5 font-medium">
    <span
      class="grid size-5 shrink-0 place-items-center rounded-full border border-border text-label text-muted tabular-nums"
      aria-hidden="true">{number}</span
    >
    {text}
  </h3>
{/snippet}

<Dialog.Root>
  <Dialog.Trigger class="{sidebarItem} data-[state=open]:bg-hover data-[state=open]:text-text">
    <Plug class="shrink-0" {...sidebarIcon} aria-hidden="true" />
    <span>Add to your agent</span>
  </Dialog.Trigger>

  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-black/45" />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 max-h-[calc(100vh-3rem)] w-[min(40rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-menu border border-border bg-menu shadow-[0_24px_60px_#00000033,0_2px_8px_#00000014]"
    >
      <div class="px-6 pt-6">
        <div class="flex items-start justify-between gap-4">
          <!-- Overwatch joined to the agent picked, so the direction of the
               connection is plain before a word of it is read. -->
          <div class="flex items-center" aria-hidden="true">
            <span
              class="grid size-10 place-items-center rounded-control border border-border bg-content"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" />
                <circle cx="12" cy="12" r="3" fill="currentColor" />
              </svg>
            </span>
            <span class="w-7 border-t border-dashed border-muted/60"></span>
            <span
              class="grid size-10 place-items-center rounded-control border border-border bg-content"
            >
              {@render clientMark(client, 18)}
            </span>
          </div>
          <Dialog.Close
            class="-m-1 grid size-7 shrink-0 place-items-center rounded-item text-muted hover:bg-hover hover:text-text"
            aria-label="Close"
          >
            <X size={15} aria-hidden="true" />
          </Dialog.Close>
        </div>

        <Dialog.Title class="mt-4 text-section">Add Overwatch to your agent</Dialog.Title>
        <Dialog.Description class="mt-0.5 text-muted">
          Your agent can then look up past sessions, usage and cost, and pace itself against your
          limits.
        </Dialog.Description>
      </div>

      <div class="grid gap-5 px-6 pt-5 pb-6">
        <section>
          {@render heading(1, "Choose your agent")}
          <div class="mt-2.5 grid grid-cols-5 gap-2" role="group" aria-label="Agent">
            {#each CLIENTS as option (option)}
              <button
                class={[
                  "flex h-17 flex-col items-center justify-center gap-2 rounded-control border text-meta",
                  option === client
                    ? "border-muted/50 bg-active text-text"
                    : "border-border text-muted hover:bg-hover hover:text-text",
                ]}
                aria-pressed={option === client}
                onclick={() => (picked = option)}
              >
                {@render clientMark(option, 18)}
                <span>{label(option)}</span>
              </button>
            {/each}
          </div>
        </section>

        <section>
          <!-- Said before the step is known, so nothing changes wording as it arrives. -->
          {@render heading(2, instruction(client))}
          <svelte:boundary>
            {#snippet pending()}
              <div
                class="mt-2.5 h-24 animate-pulse rounded-control border border-border bg-content"
                aria-hidden="true"
              ></div>
            {/snippet}

            {#snippet failed(error, reset)}
              <Failure
                class="mt-2.5"
                title="Could not find where Overwatch is."
                {error}
                onretry={() => {
                  server = locate();
                  reset();
                }}
              />
            {/snippet}

            {@const found = await server}
            {@const setup = step(client, found)}
            {#if isTranslocated(found.command)}
              <p
                class="mt-2.5 flex gap-2 rounded-control border border-warning/30 bg-warning/8 px-3 py-2.5 text-meta"
                role="alert"
              >
                <TriangleAlert class="mt-0.5 shrink-0 text-warning" size={14} aria-hidden="true" />
                <span>
                  macOS is running a temporary copy of Overwatch, so this would stop working. Move
                  Overwatch to Applications, open it from there, and come back here.
                </span>
              </p>
            {/if}
            <div class="mt-2.5 overflow-hidden rounded-control border border-border bg-content">
              <div
                class="flex h-8 items-center justify-between gap-2 border-b border-border pr-1 pl-3"
              >
                <span class="flex items-center gap-1.5 text-label text-muted">
                  {#if setup.kind === "command"}
                    <SquareTerminal size={13} aria-hidden="true" /> Terminal
                  {:else}
                    <Braces size={13} aria-hidden="true" /> JSON
                  {/if}
                </span>
                <CopyButton
                  text={setup.code}
                  label="Copy {setup.kind}"
                  class="h-6 gap-1.5 px-1.5 hover:bg-hover"
                >
                  {#snippet children(copied)}
                    <!-- Both words hold the space, so confirming the copy moves nothing. -->
                    <span class="grid text-meta">
                      <span class={["col-start-1 row-start-1", { invisible: copied }]}>Copy</span>
                      <span class={["col-start-1 row-start-1", { invisible: !copied }]}>Copied</span
                      >
                    </span>
                  {/snippet}
                </CopyButton>
              </div>
              <div class="flex gap-2 px-3 py-3 font-mono text-meta">
                {#if setup.kind === "command"}
                  <span class="text-muted select-none" aria-hidden="true">$</span>
                {/if}
                <code class="min-w-0 flex-1 whitespace-pre-wrap select-text wrap-anywhere"
                  >{setup.code}</code
                >
              </div>
            </div>
          </svelte:boundary>
        </section>

        <section>
          {@render heading(
            3,
            client === "other" ? "Restart the client, then ask" : "Start a new session, then ask",
          )}
          <ul class="mt-2.5 grid gap-1.5">
            {#each EXAMPLES as example (example)}
              <li
                class="flex items-center gap-2.5 rounded-control border border-border px-3 py-1.75 select-text"
              >
                <MessageSquareText class="shrink-0 text-muted" size={14} aria-hidden="true" />
                {example}
              </li>
            {/each}
          </ul>
        </section>
      </div>

      <p
        class="flex items-center gap-2 border-t border-border bg-content px-6 py-3.5 text-meta text-muted"
      >
        <ShieldCheck class="shrink-0" size={14} aria-hidden="true" />
        Read-only. Agents see what Overwatch has indexed, which stays current while it runs.
      </p>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
