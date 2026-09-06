/** Wait for a virtualized row to mount, then run `attempt` until it succeeds. */
export function whenPresent(root: ParentNode, attempt: () => boolean): () => void {
  let frame = 0;
  const run = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (!attempt()) return;
      observer.disconnect();
      resize.disconnect();
    });
  };
  const observer = new MutationObserver(run);
  const resize = new ResizeObserver(run);
  observer.observe(root, { childList: true, subtree: true });
  if (root instanceof Element) resize.observe(root);
  run();
  return () => {
    observer.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
  };
}

export function rowButton(root: ParentNode, rowId: string) {
  return root.querySelector<HTMLButtonElement>(`[data-row-id="${CSS.escape(rowId)}"] button`);
}
