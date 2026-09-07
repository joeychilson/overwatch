import { MarkdownClient } from "@comark/react";
import rangi from "comark/plugins/rangi";
import taskList from "comark/plugins/task-list";
import { github } from "rangi/themes";
import { useMemo, type ComponentProps } from "react";
import { highlightMatches } from "@/lib/session/highlight";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { failure } from "@/lib/errors";

const plugins = [rangi({ theme: github }), taskList()];
const options = { registerDefaultPlugins: false, headingIds: false };
const components = {
  mark: ({ children }: ComponentProps<"mark">) => (
    <mark className="rounded-sm bg-primary/20 text-foreground">{children}</mark>
  ),
  a: ({ href, children }: ComponentProps<"a">) => (
    <a
      href={href && /^https?:\/\//i.test(href) ? href : undefined}
      onClick={(event) => {
        event.preventDefault();
        if (href && /^https?:\/\//i.test(href))
          openUrl(href).catch((error: unknown) => toast.error(failure(error).message));
      }}
    >
      {children}
    </a>
  ),
  img: ({ alt }: ComponentProps<"img">) => (
    <span className="text-muted-foreground">[Image{alt ? `: ${alt}` : ""}]</span>
  ),
};
export function Markdown({ text, search = "" }: { text: string; search?: string }) {
  const activePlugins = useMemo(
    () => (search ? [...plugins, highlightMatches(search)] : plugins),
    [search],
  );
  return (
    <MarkdownClient
      value={text}
      className="prose"
      options={options}
      plugins={activePlugins}
      components={components}
    />
  );
}
