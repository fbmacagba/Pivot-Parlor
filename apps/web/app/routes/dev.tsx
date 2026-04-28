import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import { requireRole } from "~/lib/auth";
import { DashboardLayout } from "~/components/dashboards/DashboardLayout";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const url = new URL(request.url);

  if (url.pathname === "/dev/login") {
    const next = url.searchParams.get("redirect") ?? "/dev";
    throw redirect(`/login?redirect=${encodeURIComponent(next)}`);
  }

  const user = await requireRole(request, "developer", env.API_URL);
  return json({ user });
}

export default function DevLayout() {
  const { user } = useLoaderData<typeof loader>();

  return (
    <DashboardLayout
      role="developer"
      topBarTitle="Pivot Parlor Platform"
      userName={user?.sub}
    />
  );
}
