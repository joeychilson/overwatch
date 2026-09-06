import { expect, it } from "vite-plus/test";
import { parseCatalog } from "./catalog";
import { modelNameLookup } from "./name";

it("resolves exact display names without guessing ambiguous providers or model variants", () => {
  const models = parseCatalog({
    first: {
      name: "First",
      models: {
        known: { id: "known", name: "Readable Model" },
        conflict: { id: "conflict", name: "First Model" },
      },
    },
    second: {
      name: "Second",
      models: {
        known: { id: "known", name: "Readable Model" },
        conflict: { id: "conflict", name: "Second Model" },
      },
    },
  });
  for (const catalog of [models, [...models].reverse()]) {
    const name = modelNameLookup(catalog);
    expect(name("known")).toBe("Readable Model");
    expect(name("conflict")).toBe("conflict");
    expect(name("known-20260101")).toBe("known-20260101");
    expect(name("missing")).toBe("missing");
    expect(name("")).toBe("Unknown model");
  }
});
