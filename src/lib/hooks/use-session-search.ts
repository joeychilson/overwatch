import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { catalogOptions } from "@/lib/queries";

// Resolve friendly catalog names once per settled query. Session metadata stays native.
export function useSessionSearch(search: string) {
  const catalog = useQuery(catalogOptions);
  return useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return [];
    return [
      ...new Set(
        catalog.data?.models
          .filter((model) => model.name.toLowerCase().includes(query))
          .map((model) => model.id) ?? [],
      ),
    ];
  }, [catalog.data, search]);
}
