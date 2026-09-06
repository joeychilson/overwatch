import type { Agent } from "./bindings";

export const agents = {
  codex: { name: "Codex", color: "var(--chart-1)" },
  claude: { name: "Claude Code", color: "var(--chart-3)" },
  opencode: { name: "OpenCode", color: "var(--chart-4)" },
  pi: { name: "Pi", color: "var(--chart-5)" },
  grok: { name: "Grok Build", color: "var(--chart-6)" },
  antigravity: { name: "Antigravity", color: "var(--chart-2)" },
} satisfies Record<Agent, { name: string; color: string }>;

export const agentIds = Object.keys(agents) as Agent[];
