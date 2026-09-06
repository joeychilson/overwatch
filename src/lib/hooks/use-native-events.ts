import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { events } from "@/lib/bindings";
import { failure } from "@/lib/errors";

export function useNativeEvents() {
  const client = useQueryClient();
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const invalidate = (queryKey: string[]) =>
      client
        .invalidateQueries({ queryKey, refetchType: document.hidden ? "none" : "active" })
        .catch((error: unknown) => toast.error(failure(error).message));
    const subscriptions = [
      events.indexChanged.listen(() => {
        void invalidate(["snapshot"]);
        void invalidate(["transcript"]);
        void invalidate(["events"]);
      }),
      events.accountsChanged.listen(() => {
        void invalidate(["accounts"]);
      }),
    ];
    for (const subscription of subscriptions)
      subscription
        .then((unlisten) => (disposed ? unlisten() : cleanups.push(unlisten)))
        .catch((error: unknown) =>
          toast.error(`Live updates unavailable: ${failure(error).message}`),
        );
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  }, [client]);
}
