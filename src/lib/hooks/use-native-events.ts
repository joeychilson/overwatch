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
      events.navigationRequested.listen(({ payload }) => {
        if (payload === "back") history.back();
        else history.forward();
      }),
      events.indexChanged.listen(({ payload }) => {
        void invalidate(["history"]);
        if (payload.progress) return;
        for (const key of ["sessions", "session-navigation", "usage", "tools", "log-allowances"])
          void invalidate([key]);
        for (const key of ["transcript", "events"]) {
          if (payload.sessions === null) void invalidate([key]);
          else for (const id of payload.sessions) void invalidate([key, id]);
        }
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
