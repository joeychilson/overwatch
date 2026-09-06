import { defineConfig, lazyPlugins } from "vite-plus";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    ignorePatterns: ["public/catalog.json", "src/lib/bindings.ts"],
    sortTailwindcss: { stylesheet: "./src/app.css" },
  },
  lint: {
    ignorePatterns: ["src/lib/bindings.ts"],
    plugins: ["typescript", "unicorn", "oxc", "react"],
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: {
      "vite-plus/prefer-vite-plus-imports": "error",
      "react/rules-of-hooks": "error",
      "react/exhaustive-deps": "warn",
    },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(async () => {
    const [{ default: react }, { default: tailwindcss }] = await Promise.all([
      import("@vitejs/plugin-react"),
      import("@tailwindcss/vite"),
    ]);
    return [tailwindcss(), react()];
  }),
  resolve: {
    tsconfigPaths: true,
  },
  clearScreen: false,
  build: {
    target: "safari16.4",
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: "react", test: /node_modules\/(?:react|react-dom|scheduler)\// }],
        },
      },
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    server: { deps: { inline: ["vite-plus"] } },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
