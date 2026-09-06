import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { commands, type Preferences } from "@/lib/bindings";
import { native } from "@/lib/errors";
import { preferenceOptions } from "@/lib/queries";

const defaultPreferences: Preferences = {
  theme: "dark",
  savedModels: [],
  sidebarCollapsed: false,
};

export function usePreferences() {
  const client = useQueryClient();
  const query = useQuery(preferenceOptions);
  const mutation = useMutation({
    mutationKey: ["preferences"],
    mutationFn: (preferences: Preferences) => native(commands.savePreferences(preferences)),
    onSuccess: (preferences) => client.setQueryData(preferenceOptions.queryKey, preferences),
    scope: { id: "preferences" },
  });
  const pending = useIsMutating({ mutationKey: ["preferences"] });
  return {
    ...query,
    preferences: query.data ?? defaultPreferences,
    save: mutation.mutate,
    saving: pending > 0 || !query.data,
  };
}
