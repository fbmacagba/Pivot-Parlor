import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Outlet } from "@remix-run/react";
import { requireRole } from "~/lib/auth";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  if (!user.shop_id) {
    throw redirect("/admin");
  }
  return json({ user, shopId: user.shop_id });
}

export default function SetupLayout() {
  return <Outlet />;
}
