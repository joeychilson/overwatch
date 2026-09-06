import { commands } from "./bindings";
import { native } from "./errors";

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
