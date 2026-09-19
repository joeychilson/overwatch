/**
 * Presentation of a failure. The engine rejects with a plain object rather than
 * an `Error`, which `String(value)` would turn into `[object Object]`, so
 * everything that shows a failure goes through here.
 */
import { isEngineError } from "./api/backend.ts";

/** One failure as a single line. */
export function errorLine(error: unknown): string {
  if (error === null || error === undefined) return "";
  if (isEngineError(error)) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") return JSON.stringify(error);
  return String(error as string | number | boolean);
}
