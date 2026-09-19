/**
 * Putting text on the clipboard.
 *
 * WebKit lets a page write to the clipboard only while it handles the gesture
 * that asked for it. Text that takes a moment to assemble, such as a whole
 * conversation read a page at a time, would arrive after the gesture had ended
 * and be refused, so it is handed over inside the gesture as a promise, which
 * the clipboard waits for.
 */

/** Put text on the clipboard, or text still being assembled. */
export async function copyText(text: string | Promise<string>): Promise<void> {
  if (typeof text === "string") {
    await navigator.clipboard.writeText(text);
    return;
  }
  const blob = text.then((value) => new Blob([value], { type: "text/plain" }));
  await navigator.clipboard.write([new ClipboardItem({ "text/plain": blob })]);
}
