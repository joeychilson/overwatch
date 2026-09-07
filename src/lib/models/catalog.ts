import { z } from "zod";
import { commands, type CatalogPayload } from "../bindings";
import { AppFailure, failure, native } from "../errors";

const nonnegative = z.number().nonnegative();

const rawModel = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  family: z.string().optional(),
  limit: z.object({ context: nonnegative.optional(), output: nonnegative.optional() }).optional(),
  cost: z
    .object({
      input: nonnegative.optional(),
      output: nonnegative.optional(),
      cache_read: nonnegative.optional(),
      cache_write: nonnegative.optional(),
    })
    .optional(),
  modalities: z
    .object({ input: z.array(z.string()).optional(), output: z.array(z.string()).optional() })
    .optional(),
  reasoning: z.boolean().optional(),
  tool_call: z.boolean().optional(),
  open_weights: z.boolean().optional(),
  release_date: z.string().optional(),
  knowledge: z.string().optional(),
});

const catalogSchema = z
  .record(z.string(), z.object({ name: z.string(), models: z.record(z.string(), rawModel) }))
  .refine((providers) => Object.keys(providers).length > 0, "The catalog is empty");

export type Model = {
  key: string;
  id: string;
  name: string;
  provider: string;
  providerName: string;
  description: string;
  family: string;
  context: number;
  outputLimit: number;
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  reasoning: boolean;
  tools: boolean;
  vision: boolean;
  openWeights: boolean;
  releaseDate: string;
  knowledge: string;
};

export type Catalog = Omit<CatalogPayload, "json"> & { models: Model[] };

export const emptyModels: Model[] = [];

export function parseCatalog(value: unknown): Model[] {
  const result = catalogSchema.safeParse(value);
  if (!result.success)
    throw new AppFailure({
      kind: "catalog",
      message: `The models.dev catalog failed validation at ${result.error.issues[0]?.path.join(".") || "providers"}.`,
    });
  return Object.entries(result.data).flatMap(([provider, data]) =>
    Object.entries(data.models).map(([id, model]) => ({
      key: `${provider}/${id}`,
      id,
      provider,
      providerName: data.name,
      name: model.name,
      description: model.description ?? "",
      family: model.family ?? "",
      context: model.limit?.context ?? 0,
      outputLimit: model.limit?.output ?? 0,
      inputPrice: model.cost?.input ?? null,
      outputPrice: model.cost?.output ?? null,
      cacheReadPrice: model.cost?.cache_read ?? null,
      cacheWritePrice: model.cost?.cache_write ?? null,
      reasoning: model.reasoning ?? false,
      tools: model.tool_call ?? false,
      vision: model.modalities?.input?.includes("image") ?? false,
      openWeights: model.open_weights ?? false,
      releaseDate: model.release_date ?? "",
      knowledge: model.knowledge ?? "",
    })),
  );
}

export async function getCatalog(refresh = false, details = false): Promise<Catalog> {
  const payload = await native(
    commands.getCatalog(refresh ? "refresh" : details ? "stored" : "compact"),
  );
  try {
    const catalog = decode(payload);
    if (refresh) await native(commands.saveCatalog(payload));
    return catalog;
  } catch (error) {
    if (refresh || payload.source === "bundled") throw error;
    const fallback = decode(
      await native(commands.getCatalog(details ? "bundled" : "compactbundled")),
    );
    return {
      ...fallback,
      warning: {
        kind: "invalidData",
        message: `Using the offline catalog: ${failure(error).message}`,
      },
    };
  }
}

function decode(payload: CatalogPayload): Catalog {
  let value: unknown;
  try {
    value = JSON.parse(payload.json);
  } catch {
    throw new AppFailure({ kind: "catalog", message: "The model catalog contains invalid JSON." });
  }
  return {
    models: parseCatalog(value),
    updatedAt: payload.updatedAt,
    source: payload.source,
    warning: payload.warning,
  };
}
