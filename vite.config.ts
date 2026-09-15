import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite-plus";

const host = process.env.TAURI_DEV_HOST ?? "127.0.0.1";

export default defineConfig({
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter({ fallback: "index.html" }),
      compilerOptions: {
        experimental: { async: true },
      },
      version: { pollInterval: 0 },
    }),
  ],
  clearScreen: false,
  // Unit tests live beside the module they cover. `tests/` holds the Playwright
  // suite, whose files would otherwise be collected here and fail to load.
  test: { include: ["src/**/*.test.ts"] },
  server: {
    host,
    port: 1430,
    strictPort: true,
    hmr: { host, port: 1431 },
    watch: { ignored: ["**/src-tauri/**"] },
  },
  preview: { host: "127.0.0.1", port: 1432, strictPort: true },
  build: { target: "safari16.4" },
  fmt: {
    svelte: true,
    // The price table is generated one model per line, so a price change is a
    // one-line diff.
    ignorePatterns: [
      ".svelte-kit/**",
      "build/**",
      "src-tauri/target/**",
      "src-tauri/gen/**",
      "src-tauri/src/prices.json",
    ],
  },
  lint: {
    ignorePatterns: [".svelte-kit/**", "build/**", "src-tauri/**"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
