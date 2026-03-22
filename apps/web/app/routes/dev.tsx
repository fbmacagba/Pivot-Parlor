import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Outlet, useLoaderData } from "@remix-run/react";
import { requireRole } from "~/lib/auth";
import { DashboardLayout } from "~/components/dashboards/DashboardLayout";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const url = new URL(request.url);

  // Critical: `/dev/login` is a *child* route of `/dev`.
  // Remix runs this parent loader for `/dev/*`, so without this bypass,
  // unauthenticated users get redirected to `/dev/login` repeatedly.
  if (url.pathname === "/dev/login") {
    return json({ user: null, isDevLoginRoute: true });
  }

  const user = await requireRole(request, "developer", env.API_URL);
  return json({ user, isDevLoginRoute: false });
}

export default function DevLayout() {
  const { user, isDevLoginRoute } = useLoaderData<typeof loader>();

  if (isDevLoginRoute) {
    // Render the child route (`dev.login.tsx`) without the dashboard chrome.
    return <Outlet />;
  }

  return (
    <DashboardLayout
      role="developer"
      topBarTitle="Pivot Parlor Platform"
      userName={user?.sub}
    />
  );
}
