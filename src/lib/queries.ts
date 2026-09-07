import { MutationCache, QueryClient, queryOptions } from "@tanstack/react-query";
import { isTauri } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { commands } from "./bindings";
import { getCatalog } from "./models/catalog";
import { AppFailure, failure, native } from "./errors";

export const queryClient = new QueryClient({
  mutationCache: new MutationCache({ onError: (error) => toast.error(failure(error).message) }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: (attempt, error) =>
        attempt < 1 &&
        !(
          error instanceof AppFailure &&
          ["credentials", "unauthorized", "invalidData", "catalog", "desktop"].includes(
            error.detail.kind,
          )
        ),
      refetchOnWindowFocus: true,
    },
  },
});

export const snapshotOptions = queryOptions({
  queryKey: ["snapshot"],
  queryFn: () => native(commands.getSnapshot()),
  enabled: isTauri(),
  staleTime: Infinity,
});

export const catalogOptions = queryOptions({
  queryKey: ["catalog", "pricing"],
  queryFn: () => getCatalog(),
  enabled: isTauri(),
  staleTime: Infinity,
});

export const fullCatalogOptions = queryOptions({
  queryKey: ["catalog", "details"],
  queryFn: () => getCatalog(false, true),
  enabled: isTauri(),
  staleTime: Infinity,
});

export const accountOptions = queryOptions({
  queryKey: ["accounts"],
  queryFn: () => native(commands.getAccounts()),
  enabled: isTauri(),
  staleTime: Infinity,
});

export const preferenceOptions = queryOptions({
  queryKey: ["preferences"],
  queryFn: () => native(commands.getPreferences()),
  enabled: isTauri(),
  staleTime: Infinity,
});

export function eventPageOptions(id: string, search: string, offset: number) {
  return queryOptions({
    queryKey: ["events", id, search, offset],
    queryFn: () => native(commands.getEvents(id, offset, search)),
    // Only keep bodies near the viewport; the lightweight timeline stays in the transcript cache.
    gcTime: 0,
  });
}
