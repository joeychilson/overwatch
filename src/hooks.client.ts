/**
 * What this window does with an error it did not expect. An engine failure is
 * already shown by the boundary that caught it, so only a bug in the window is
 * logged, where it will be noticed.
 */
import type { HandleClientError } from "@sveltejs/kit/hooks";
import { isEngineError } from "#lib/api/backend.ts";

export const handleError: HandleClientError = (caught) => {
  // SvelteKit's own errors, such as a 404, already carry a safe message.
  if (caught.kind !== "unknown") return;

  // Its message is safe to show, and a better error page than "Internal Error".
  if (isEngineError(caught.error)) return { message: caught.error.message };

  console.error(caught.error);
  return { message: "Something in this window went wrong." };
};
