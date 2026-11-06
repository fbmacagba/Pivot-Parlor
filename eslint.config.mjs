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
  // Local tools are run by hand, never as a turbo task, so their env vars
  // have no turbo cache key to declare.
  {
    files: ["tools/**/*.mjs"],
    rules: { "turbo/no-undeclared-env-vars": "off" },
  },
];
