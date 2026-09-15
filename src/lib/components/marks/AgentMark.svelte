<script lang="ts">
  /** The mark for one agent. */
  import type { Agent } from "#lib/api/backend.ts";
  import { agentDisplay } from "#lib/agents.ts";
  import Mark from "./Mark.svelte";

  interface Props {
    agent: Agent;
    size?: number;
    /** Accessible name, when no adjacent text names the agent. */
    labelled?: boolean;
    class?: string;
  }

  let { agent, size = 20, labelled = false, class: className = "" }: Props = $props();

  const display = $derived(agentDisplay(agent));
</script>

<Mark name={display.mark} {size} label={labelled ? display.name : undefined} class={className} />
