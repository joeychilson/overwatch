import { commands } from "./bindings";
import { native, failure } from "./errors";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

export function csv(rows: readonly (readonly (string | number | null)[])[]): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          let text = value == null ? "" : String(value);
          if (typeof value === "string" && /^[\s]*[=+@-]/.test(text)) text = `'${text}`;
          return `"${text.replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\r\n");
}

export const exportCsv = (name: string, rows: readonly (readonly (string | number | null)[])[]) =>
  native(commands.exportFile(name, csv(rows)));

export function confirmExport(path: string | null) {
  if (!path) return;
  toast.success("Export saved", {
    description: path,
    duration: 8000,
    action: {
      label: /Mac/.test(navigator.platform) ? "Reveal in Finder" : "Show in folder",
      onClick: () =>
        void revealItemInDir(path).catch((error: unknown) => toast.error(failure(error).message)),
    },
  });
}
