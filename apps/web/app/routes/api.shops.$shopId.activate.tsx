import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { proxyShopPost } from "~/lib/worker-proxy";

export const action = (args: ActionFunctionArgs) => proxyShopPost(args, "activate");

export default function ApiShopActivate() {
  return null;
}
