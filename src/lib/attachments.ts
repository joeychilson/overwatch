/** Behaviour an element takes on through `{@attach}`. */
import type { Attachment } from "svelte/attachments";

/** Call `reached` whenever the element comes into view, as the end of a list read so far does. */
export function onReach(reached: () => void): Attachment<HTMLElement> {
  return (node) => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) reached();
    });
    observer.observe(node);
    return () => observer.disconnect();
  };
}
