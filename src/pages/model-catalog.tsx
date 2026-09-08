import { useDeferredValue, useMemo, useState, type RefObject } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, GitCompareArrows, RefreshCw, Star, X } from "lucide-react";
import { emptyModels, getCatalog, type Catalog, type Model } from "@/lib/models/catalog";
import { compact, integer, money } from "@/lib/format";
import { catalogOptions, fullCatalogOptions } from "@/lib/queries";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { Button } from "@/lib/components/ui/button";
import { Checkbox } from "@/lib/components/ui/checkbox";
import { Capabilities, CatalogDialogs } from "@/lib/components/catalog-dialogs";
import { DataTable, type DataColumn } from "@/lib/components/data-table";
import { FilterSelect, PageHeader, SearchField } from "@/lib/components/page";

export default function ModelCatalog({
  catalog,
  offerings,
  scrollRef,
}: {
  catalog?: Catalog;
  offerings: string[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const client = useQueryClient();
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search.toLowerCase());
  const [provider, setProvider] = useState("all");
  const [view, setView] = useState<"all" | "used" | "saved">("all");
  const [capability, setCapability] = useState<
    "all" | "reasoning" | "tools" | "vision" | "openWeights"
  >("all");
  const [selected, setSelected] = useState<string | null>(null);
  const [compare, setCompare] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const { preferences, save, saving } = usePreferences();
  const refresh = useMutation({
    mutationKey: ["catalog-refresh"],
    scope: { id: "catalog-refresh" },
    mutationFn: () => getCatalog(true),
    onSuccess: async (catalog) => {
      client.setQueryData(fullCatalogOptions.queryKey, catalog);
      await client.invalidateQueries(catalogOptions);
    },
  });
  const refreshing = useIsMutating({ mutationKey: ["catalog-refresh"] }) > 0;
  const models = catalog?.models ?? emptyModels;
  const used = useMemo(() => new Set(offerings), [offerings]);
  const providers = useMemo(
    () =>
      [...new Map(models.map((model) => [model.provider, model.providerName])).entries()].sort(
        (a, b) => a[1].localeCompare(b[1]),
      ),
    [models],
  );
  const saved = useMemo(() => new Set(preferences.savedModels), [preferences.savedModels]);
  const byKey = useMemo(() => new Map(models.map((model) => [model.key, model])), [models]);
  const sortedModels = useMemo(
    () =>
      [...models].sort(
        (a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.name.localeCompare(b.name),
      ),
    [models],
  );
  const filtered = useMemo(
    () =>
      sortedModels.filter(
        (model) =>
          (provider === "all" || model.provider === provider) &&
          (capability === "all" || model[capability]) &&
          (view === "all" || (view === "saved" ? saved.has(model.key) : used.has(model.key))) &&
          `${model.name} ${model.id} ${model.providerName} ${model.family}`
            .toLowerCase()
            .includes(deferred),
      ),
    [sortedModels, provider, capability, view, saved, used, deferred],
  );
  const detail = selected ? byKey.get(selected) : undefined;
  const comparison = compare.flatMap((key) => {
    const model = byKey.get(key);
    return model ? [model] : [];
  });
  function toggleSaved(key: string) {
    save({
      ...preferences,
      savedModels: saved.has(key)
        ? preferences.savedModels.filter((model) => model !== key)
        : [...preferences.savedModels, key],
    });
  }
  function toggleCompare(key: string) {
    setCompare((previous) =>
      previous.includes(key)
        ? previous.filter((model) => model !== key)
        : [...previous, key].slice(0, 3),
    );
  }
  const columns: DataColumn<Model>[] = [
    {
      id: "compare",
      width: 44,
      header: "",
      enableSorting: false,
      cell: ({ row }) => (
        <Checkbox
          aria-label={`Compare ${row.original.name} from ${row.original.providerName}`}
          checked={compare.includes(row.original.key)}
          disabled={compare.length === 3 && !compare.includes(row.original.key)}
          onCheckedChange={() => toggleCompare(row.original.key)}
        />
      ),
    },
    {
      accessorKey: "name",
      header: "Model",
      width: 280,
      grow: true,
      cell: ({ row }) => (
        <div>
          <button
            className="block max-w-full truncate text-left text-[13px] font-medium hover:text-primary"
            title={row.original.name}
            onClick={() => setSelected(row.original.key)}
          >
            {row.original.name}
          </button>
          <p className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="truncate" title={row.original.providerName}>
              {row.original.providerName}
            </span>
            {used.has(row.original.key) && (
              <span className="shrink-0 text-primary">In your history</span>
            )}
          </p>
        </div>
      ),
    },
    {
      accessorKey: "context",
      header: "Context",
      width: 104,
      cell: ({ row }) => (row.original.context ? compact(row.original.context) : "—"),
    },
    {
      accessorKey: "inputPrice",
      header: "Input / 1M",
      width: 116,
      cell: ({ row }) => money(row.original.inputPrice),
    },
    {
      accessorKey: "outputPrice",
      header: "Output / 1M",
      width: 116,
      cell: ({ row }) => money(row.original.outputPrice),
    },
    {
      accessorKey: "cacheReadPrice",
      header: "Cached / 1M",
      width: 128,
      cell: ({ row }) => (
        <span className="text-muted-foreground">{money(row.original.cacheReadPrice)}</span>
      ),
    },
    {
      id: "capabilities",
      header: "Capabilities",
      width: 148,
      cell: ({ row }) => <Capabilities model={row.original} />,
    },
    {
      id: "save",
      width: 56,
      header: "",
      cell: ({ row }) => (
        <Button
          aria-label={`${saved.has(row.original.key) ? "Unsave" : "Save"} ${row.original.name}`}
          variant="ghost"
          size="icon-sm"
          disabled={saving}
          className="disabled:pointer-events-auto"
          onClick={() => toggleSaved(row.original.key)}
        >
          <Star
            className={
              saved.has(row.original.key) ? "fill-warning text-warning" : "text-muted-foreground"
            }
          />
        </Button>
      ),
    },
  ];
  return (
    <>
      <PageHeader
        icon={<BookOpen />}
        title="Pricing catalog"
        description="Compare provider offerings, published prices, and capabilities."
        action={
          <Button variant="outline" disabled={refreshing} onClick={() => refresh.mutate()}>
            <RefreshCw className={refreshing ? "animate-spin" : ""} />
            Refresh catalog
          </Button>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-1">
        {(
          [
            { value: "all", label: "All models" },
            { value: "used", label: "Your models" },
            { value: "saved", label: "Saved" },
          ] as const
        ).map((item) => (
          <Button
            key={item.value}
            variant={view === item.value ? "secondary" : "ghost"}
            onClick={() => setView(item.value)}
            aria-pressed={view === item.value}
          >
            {item.label}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {integer(filtered.length)} models
        </span>
      </div>
      {view === "used" && (
        <p className="mb-5 text-sm text-muted-foreground">
          Catalog offerings matched to usage across all your local history. For usage by period,
          including models missing from the catalog, open Models.
        </p>
      )}
      <div className="mb-5 flex flex-wrap gap-3">
        <SearchField value={search} onChange={setSearch} placeholder="Search models…" />
        <FilterSelect
          label="Model provider"
          value={provider}
          onChange={setProvider}
          options={[
            { value: "all", label: "All providers" },
            ...providers.map(([value, label]) => ({ value, label })),
          ]}
        />
        <FilterSelect
          label="Model capability"
          value={capability}
          onChange={setCapability}
          options={[
            { value: "all", label: "All capabilities" },
            { value: "reasoning", label: "Reasoning" },
            { value: "tools", label: "Tool use" },
            { value: "vision", label: "Vision" },
            { value: "openWeights", label: "Open weights" },
          ]}
        />
      </div>
      <DataTable
        label="Model catalog"
        data={filtered}
        columns={columns}
        rowKey={(model) => model.key}
        scrollRef={scrollRef}
        onRowClick={(model) => setSelected(model.key)}
      />
      <p className="mt-5 text-[11px] text-muted-foreground">
        models.dev ·{" "}
        {catalog ? new Date(catalog.updatedAt).toLocaleDateString() : "Loading catalog"} ·{" "}
        {catalog?.source === "bundled" ? "Bundled offline catalog" : "Cached locally"} · USD per
        million tokens
      </p>
      {comparison.length > 0 && (
        <div className="sticky bottom-3 mt-6 flex items-center gap-3 rounded-xl bg-popover p-3 shadow-lg">
          <GitCompareArrows className="size-4 text-primary" />
          <span className="text-xs">{comparison.length} selected</span>
          <div className="flex flex-1 flex-wrap gap-2">
            {comparison.map((model) => (
              <Button
                key={model.key}
                variant="secondary"
                size="xs"
                onClick={() => toggleCompare(model.key)}
                className="max-w-44"
              >
                <span className="truncate">{model.name}</span>
                <X />
              </Button>
            ))}
          </div>
          <Button disabled={comparison.length < 2} onClick={() => setComparing(true)}>
            Compare
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Clear comparison"
            onClick={() => setCompare([])}
          >
            <X />
          </Button>
        </div>
      )}
      <CatalogDialogs
        detail={detail}
        comparison={comparison}
        comparing={comparing}
        saved={saved}
        saving={saving}
        onSelect={setSelected}
        onToggleSaved={toggleSaved}
        onComparingChange={setComparing}
      />
    </>
  );
}
