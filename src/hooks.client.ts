/**
 * What this window does with an error it did not expect.
 *
 * SvelteKit logs unknown errors to the console by default. That is right for a
 * bug in this window, and wrong for an engine failure: those are typed and
 * already shown to the reader by the boundary that caught them, so logging them
 * again only hides the errors worth noticing.
 */
import type { HandleClientError } from "@sveltejs/kit/hooks";
import { isEngineError } from "#lib/api/backend.ts";

export const handleError: HandleClientError = (caught) => {
  // SvelteKit's own errors, such as a 404, already carry a safe message.
  if (caught.kind !== "unknown") return;

  if (isEngineError(caught.error)) {
    // Reported where it happened. Its message is safe to show and carries the
    // engine's own classification, so it makes a better error page than
    // "Internal Error" if one is ever reached.
    return { message: caught.error.message };
  }

  console.error(caught.error);
  return { message: "Something in this window went wrong." };
};
