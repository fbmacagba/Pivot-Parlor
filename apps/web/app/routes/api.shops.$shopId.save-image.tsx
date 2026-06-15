import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { proxyShopPost } from "~/lib/worker-proxy";

export const action = (args: ActionFunctionArgs) => proxyShopPost(args, "save-image", { forwardBody: true });

export default function ApiShopSaveImage() {
  return null;
}
