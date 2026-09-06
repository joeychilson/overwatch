import type { Agent } from "@/lib/bindings";
import { cn } from "@/lib/ui";

const logos: Record<Agent, string> = {
  codex: "openai",
  claude: "anthropic",
  grok: "xai",
  antigravity: "google",
  opencode: "opencode",
  pi: "pi",
};
export function AgentMark({ agent, className }: { agent: Agent; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted text-sm font-medium",
        className,
      )}
    >
      <img
        className={cn("size-[62%] dark:invert", agent === "pi" && "scale-75")}
        src={`/logos/${logos[agent]}.svg`}
        alt=""
      />
    </span>
  );
}
