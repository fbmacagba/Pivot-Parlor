import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { proxyShopPost } from "~/lib/worker-proxy";

export const action = (args: ActionFunctionArgs) => proxyShopPost(args, "settings", { forwardBody: true });
