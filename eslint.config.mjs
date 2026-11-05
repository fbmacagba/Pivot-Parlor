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
];
