import { config } from "@repo/eslint-config/react-internal";
import { globalIgnores } from "eslint/config";

/** @type {import("eslint").Linter.Config[]} */
export default [
  globalIgnores([
    "build/**",
    ".pages-dist/**",
    // Committed JS mirrors of TS sources — lint TS only
    "app/**/*.js",
  ]),
  ...config,
];
