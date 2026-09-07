import { describe, expect, it } from "vite-plus/test";
import { parseCatalog } from "./catalog";

describe("model catalog", () => {
  it("validates catalog fields rather than accepting cast data", () => {
    expect(() =>
      parseCatalog({
        lab: { name: "Lab", models: { bad: { id: "bad", name: "Bad", cost: { input: "2" } } } },
      }),
    ).toThrow("validation");
    expect(() => parseCatalog({})).toThrow();
  });
});
