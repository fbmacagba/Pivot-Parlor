import { createPagesFunctionHandler } from "@remix-run/cloudflare-pages";
import type { ServerBuild } from "@remix-run/server-runtime";
import * as build from "../build/server/index.js";

export const onRequest = createPagesFunctionHandler({
  build: build as unknown as ServerBuild,
  /**
   * Expose Cloudflare environment bindings to Remix loaders/actions as
   * `context.env` so code like `context.env.API_URL` works.
   */
  getLoadContext(context) {
    return { env: context.env };
  },
});

