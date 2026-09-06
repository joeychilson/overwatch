import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { catalogOptions } from "../queries";
import { modelNameLookup } from "../models/name";

export function useModelName() {
  const catalog = useQuery(catalogOptions);
  return useMemo(() => modelNameLookup(catalog.data?.models ?? []), [catalog.data]);
}
