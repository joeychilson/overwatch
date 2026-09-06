import { Network } from "lucide-react";
import { cn } from "cn";

const logos = new Set(["openai", "anthropic", "google", "xai", "opencode"]);
export function ProviderMark({ provider, className }: { provider: string; className?: string }) {
  const logo = provider === "opencode-go" ? "opencode" : provider;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted",
        className,
      )}
    >
      {logos.has(logo) ? (
        <img src={`/logos/${logo}.svg`} alt="" className="size-[62%] dark:invert" />
      ) : (
        <Network className="size-[62%] text-muted-foreground" />
      )}
    </span>
  );
}
