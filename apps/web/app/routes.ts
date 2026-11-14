import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// The same file-based routes as Remix 2 (app/routes/*): measured identical,
// 96 routes, before the move.
export default flatRoutes() satisfies RouteConfig;
