import { expect, it } from "vite-plus/test";
import { csv } from "./export";

it("escapes CSV formulas, quotes, and line breaks", () => {
  expect(csv([["=SUM(A1)", "two\nlines", 'a"b', 12, -4]])).toBe(
    '"\'=SUM(A1)","two\nlines","a""b","12","-4"',
  );
});
