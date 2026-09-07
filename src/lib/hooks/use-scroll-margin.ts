import { useLayoutEffect, useState, type RefObject } from "react";

/** Keep virtual row positions aligned when content above the list changes size. */
export function useScrollMargin(
  root: RefObject<HTMLDivElement | null>,
  scroll: RefObject<HTMLDivElement | null>,
  enabled = true,
) {
  const [margin, setMargin] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    const viewport = scroll.current;
    if (!enabled || !element || !viewport) return;
    const measure = () =>
      setMargin(
        Math.round(
          element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop,
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    for (const target of [element, viewport, viewport.firstElementChild])
      if (target) observer.observe(target);
    return () => observer.disconnect();
  }, [root, scroll, enabled]);
  return margin;
}
