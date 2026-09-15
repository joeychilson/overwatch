/**
 * Presentation of a failure.
 *
 * The engine rejects with a plain object carrying a stable kind and a message
 * safe to show. It is not an `Error`, so anything reaching for `.message` or
 * falling back to `String(value)` turns a useful failure into `[object
 * Object]`. Everything that shows a failure goes through here instead.
 */
import { isEngineError } from "./api/backend.ts";

/** One failure as a single line. */
export function errorLine(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (isEngineError(error)) return error.message;
  if (error instanceof Error) return error.message;
  // Anything else is unexpected. JSON keeps a shape readable where the default
  // stringification would flatten it to `[object Object]`, which is exactly the
  // failure this module exists to prevent.
  if (typeof error === "object") return JSON.stringify(error);
  return String(error as string | number | boolean);
}
