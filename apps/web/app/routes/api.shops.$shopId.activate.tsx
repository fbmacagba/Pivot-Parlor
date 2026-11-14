import type { ActionFunctionArgs } from "react-router";
import { proxyShopPost } from "~/lib/worker-proxy";

export const action = (args: ActionFunctionArgs) => proxyShopPost(args, "activate");
