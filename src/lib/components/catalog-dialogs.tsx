import { useState } from "react";
import { Brain, Check, Eye, Star, Wrench } from "lucide-react";
import type { Model } from "@/lib/models/catalog";
import { tokenCost } from "@/lib/usage/costs";
import { integer, money } from "@/lib/format";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Modal } from "./page";

const modelProperties: { label: string; value: (model: Model) => string }[] = [
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

export function Capabilities({ model }: { model: Model }) {
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
                setTokens((previous) => ({
                  ...previous,
                  [key]: Number.isFinite(value) ? Math.max(0, Math.min(1e12, value)) : 0,
                }));
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

export function CatalogDialogs({
  detail,
  comparison,
  comparing,
  saved,
  saving,
  onSelect,
  onToggleSaved,
  onComparingChange,
}: {
  detail?: Model;
  comparison: Model[];
  comparing: boolean;
  saved: ReadonlySet<string>;
  saving: boolean;
  onSelect: (key: string | null) => void;
  onToggleSaved: (key: string) => void;
  onComparingChange: (open: boolean) => void;
}) {
  return (
    <>
      <Modal
        open={!!detail}
        onOpenChange={(open) => {
          if (!open) onSelect(null);
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
                onClick={() => onToggleSaved(detail.key)}
              >
                {saved.has(detail.key) ? <Check /> : <Star />}
                {saved.has(detail.key) ? "Saved" : "Save model"}
              </Button>
            </div>
            {detail.description && (
              <p className="text-sm leading-relaxed text-muted-foreground">{detail.description}</p>
            )}
            <dl className="grid grid-cols-2 gap-x-8 gap-y-4">
              {modelProperties.map((row) => (
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
        onOpenChange={onComparingChange}
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
              {modelProperties.map((row) => (
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
