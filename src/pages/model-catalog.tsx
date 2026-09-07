import { useDeferredValue, useMemo, useState, type RefObject } from "react";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Check, Eye, GitCompareArrows, RefreshCw, Star, Wrench, X } from "lucide-react";
import type { Session } from "@/lib/bindings";
import { emptyModels, getCatalog, type Catalog, type Model } from "@/lib/models/catalog";
import { tokenCost } from "@/lib/usage/costs";
import { compact, integer, money } from "@/lib/format";
import { catalogOptions, fullCatalogOptions } from "@/lib/queries";
import { usePreferences } from "@/lib/hooks/use-preferences";
import { Button } from "@/lib/components/ui/button";
import { Checkbox } from "@/lib/components/ui/checkbox";
import { Input } from "@/lib/components/ui/input";
import { DataTable, type DataColumn } from "@/lib/components/data-table";
import { FilterSelect, Modal, PageTitle, SearchField } from "@/lib/components/page";

function Capabilities({ model }: { model: Model }) {
  return (
    <div className="flex gap-2 text-muted-foreground">
      {model.reasoning && (
        <Brain className="size-3.5" aria-label="Reasoning">
          <title>Reasoning</title>
        </Brain>
      )}
      {model.tools && (
        <Wrench className="size-3.5" aria-label="Tool use">
          <title>Tool use</title>
        </Wrench>
      )}
      {model.vision && (
        <Eye className="size-3.5" aria-label="Vision">
          <title>Vision</title>
        </Eye>
      )}
      {model.openWeights && <span className="rounded bg-muted px-1.5 text-[11px]">Open</span>}
    </div>
  );
}

function Calculator({ models }: { models: Model[] }) {
  const [tokens, setTokens] = useState({
    input: 100_000,
    cacheRead: 0,
    cacheWrite: 0,
    output: 10_000,
    reasoning: 0,
  });
  return (
    <section>
      <h3 className="mb-4 text-sm font-medium">Cost calculator</h3>
      <div className="grid grid-cols-2 gap-4">
        {(
          [
            ["input", "Uncached input"],
            ["cacheRead", "Cached input"],
            ["cacheWrite", "Cache writes"],
            ["output", "Output"],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="space-y-2 text-xs text-muted-foreground">
            <span>{label} tokens</span>
            <Input
              type="number"
              min="0"
              max="1000000000000"
              step="1000"
              value={tokens[key]}
              onChange={(event) => {
                const value = event.currentTarget.valueAsNumber;
                setTokens({
                  ...tokens,
                  [key]: Number.isFinite(value) ? Math.max(0, Math.min(1e12, value)) : 0,
                });
              }}
            />
          </label>
        ))}
      </div>
      <div className="mt-5 space-y-3 rounded-xl bg-muted/60 p-4">
        {models.map((model) => {
          const cost = tokenCost(tokens, model);
          return (
            <div key={model.key} className="flex items-center justify-between gap-4">
              <span className="text-xs text-muted-foreground">{model.name}</span>
              <span className="text-lg font-medium tabular-nums">
                {cost == null ? "Price unavailable" : money(cost)}
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
        Current USD list rates. Missing cache prices remain unknown. Long-context tiers, service
        tiers, non-text modalities, taxes, and discounts may differ.
      </p>
    </section>
  );
}

export default function Models({
  catalog,
  sessions,
  scrollRef,
}: {
  catalog?: Catalog;
  sessions: Session[];
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
  const used = useMemo(() => {
    const keys = new Set<string>();
    for (const session of sessions)
      for (const usage of session.usage) keys.add(`${usage.provider}/${usage.model}`);
    return keys;
  }, [sessions]);
  const providers = useMemo(
    () =>
      [...new Map(models.map((model) => [model.provider, model.providerName])).entries()].sort(
        (a, b) => a[1].localeCompare(b[1]),
      ),
    [models],
  );
  const saved = new Set(preferences.savedModels);
  const filtered = useMemo(
    () =>
      models
        .filter(
          (model) =>
            (provider === "all" || model.provider === provider) &&
            (capability === "all" || model[capability]) &&
            (view === "all" ||
              (view === "saved"
                ? preferences.savedModels.includes(model.key)
                : used.has(model.key))) &&
            `${model.name} ${model.id} ${model.providerName} ${model.family}`
              .toLowerCase()
              .includes(deferred),
        )
        .sort((a, b) => b.releaseDate.localeCompare(a.releaseDate) || a.name.localeCompare(b.name)),
    [models, provider, capability, view, preferences.savedModels, used, deferred],
  );
  const detail = models.find((model) => model.key === selected);
  const comparison = compare.flatMap((key) => {
    const model = models.find((model) => model.key === key);
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
    setCompare(
      compare.includes(key)
        ? compare.filter((model) => model !== key)
        : [...compare, key].slice(0, 3),
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
  const rows: { label: string; value: (model: Model) => string }[] = [
    { label: "Input / 1M", value: (model) => money(model.inputPrice) },
    { label: "Output / 1M", value: (model) => money(model.outputPrice) },
    { label: "Cached input / 1M", value: (model) => money(model.cacheReadPrice) },
    { label: "Cache write / 1M", value: (model) => money(model.cacheWritePrice) },
    { label: "Context window", value: (model) => integer(model.context) },
    { label: "Maximum output", value: (model) => integer(model.outputLimit) },
    { label: "Reasoning", value: (model) => (model.reasoning ? "Yes" : "No") },
    { label: "Tool use", value: (model) => (model.tools ? "Yes" : "No") },
    { label: "Vision", value: (model) => (model.vision ? "Yes" : "No") },
    { label: "Open weights", value: (model) => (model.openWeights ? "Yes" : "No") },
    { label: "Release date", value: (model) => model.releaseDate || "—" },
    { label: "Knowledge cutoff", value: (model) => model.knowledge || "—" },
  ];
  return (
    <>
      <PageTitle
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
      <Modal
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title={detail?.name ?? "Model"}
        description={detail ? `${detail.providerName} · ${detail.id}` : ""}
      >
        {detail && (
          <>
            <div className="flex items-center justify-between">
              <Capabilities model={detail} />
              <Button
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => toggleSaved(detail.key)}
              >
                {saved.has(detail.key) ? <Check /> : <Star />}
                {saved.has(detail.key) ? "Saved" : "Save model"}
              </Button>
            </div>
            {detail.description && (
              <p className="text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
            )}
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4">
              {rows.map((row) => (
                <div key={row.label} className="flex justify-between gap-3 text-xs">
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd className="text-right tabular-nums">{row.value(detail)}</dd>
                </div>
              ))}
            </dl>
            <Calculator models={[detail]} />
          </>
        )}
      </Modal>
      <Modal
        open={comparing}
        onOpenChange={setComparing}
        title="Model comparison"
        description="Current list pricing and capabilities, side by side."
        className="sm:max-w-4xl"
      >
        <div className="overflow-auto">
          <table
            className="w-full table-fixed text-left text-xs"
            style={{ minWidth: 160 + comparison.length * 200 }}
            aria-label="Model comparison"
          >
            <colgroup>
              <col style={{ width: 160 }} />
              {comparison.map((model) => (
                <col key={model.key} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th />
                {comparison.map((model) => (
                  <th key={model.key} className="p-3 align-top font-medium">
                    <span className="block truncate" title={model.name}>
                      {model.name}
                    </span>
                    <p
                      className="mt-1 truncate font-normal text-muted-foreground"
                      title={model.providerName}
                    >
                      {model.providerName}
                    </p>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label}>
                  <th className="p-3 font-normal text-muted-foreground">{row.label}</th>
                  {comparison.map((model) => (
                    <td key={model.key} className="p-3 whitespace-nowrap tabular-nums">
                      {row.value(model)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Calculator models={comparison} />
      </Modal>
    </>
  );
}
