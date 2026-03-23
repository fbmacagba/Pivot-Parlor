import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useLoaderData } from "@remix-run/react";
import { requireRole } from "~/lib/auth";
import { DashboardLayout } from "~/components/dashboards/DashboardLayout";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "staff", env.API_URL);
  return json({ user });
}

export default function StaffLayout() {
  const { user } = useLoaderData<typeof loader>();
  const isDeveloper = user.role === "developer";
  return (
    <DashboardLayout
      role="staff"
      userName={user.sub}
      showDeveloperViewSwitcher={isDeveloper}
    />
  );
}
