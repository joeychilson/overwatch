<script lang="ts">
  /** The mark for one agent, decorative: whatever sits beside it names the agent. */
  import type { Agent } from "#lib/api/backend.ts";
  import { agentDisplay } from "#lib/agents.ts";
  import Mark from "./Mark.svelte";

  interface Props {
    agent: Agent;
    size?: number;
    class?: string;
  }

  let { agent, size = 20, class: className = "" }: Props = $props();
</script>

<Mark name={agentDisplay(agent).mark} {size} class={className} />
