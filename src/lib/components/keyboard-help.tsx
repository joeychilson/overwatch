import { navigation } from "@/lib/navigation";
import { Modal } from "./page";

export function KeyboardHelp({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal
      title="Keyboard shortcuts"
      description="Move through Overwatch without leaving the keyboard."
      open={open}
      onOpenChange={onOpenChange}
    >
      <dl className="space-y-5 text-sm">
        <div className="flex justify-between">
          <dt>Search pages and sessions</dt>
          <dd>
            <kbd>⌘ / Ctrl K</kbd>
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Switch views</dt>
          <dd>
            <kbd>⌘ / Ctrl 1–{navigation.length}</kbd>
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Navigate session timeline</dt>
          <dd>
            <kbd>← → Home End</kbd>
          </dd>
        </div>
        <div className="flex justify-between">
          <dt>Close dialog</dt>
          <dd>
            <kbd>Esc</kbd>
          </dd>
        </div>
      </dl>
    </Modal>
  );
}
