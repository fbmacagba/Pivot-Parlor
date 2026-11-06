import { globalIgnores } from "eslint/config";
import { config } from "./packages/eslint-config/react-internal.js";

// Root-level gate invocations use the same shared rules as the web workspace.
// Keep generated output out of scans without omitting any application sources.
export default [
  globalIgnores([
    "**/build/**",
    "**/dist/**",
    "**/.pages-dist/**",
    "**/.wrangler/**",
    "apps/web/app/**/*.js",
    "output/**",
    ".playwright-cli/**",
  ]),
  ...config,
  // Repo scripts and local tools run under Node, not in a browser, so the
  // shared web rules would flag every `process` and `Buffer` as undefined.
  {
    files: ["scripts/**/*.mjs", "tools/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", Buffer: "readonly" } },
  },
  // Run by hand or by Playwright, never as a turbo task, so their env vars
  // (DEV_PASSWORD, E2E_BASE_URL, ...) have no turbo cache key to declare.
  {
    files: ["tools/**", "scripts/**", "apps/*/scripts/**", "tests/e2e/**", "playwright.config.ts"],
    rules: { "turbo/no-undeclared-env-vars": "off" },
  },
  // A leading underscore marks a parameter that a signature requires but the
  // body does not use (e.g. the Workers `scheduled(event, env, _ctx)` handler).
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
];
