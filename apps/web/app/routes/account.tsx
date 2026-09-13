import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Form, Link, Outlet, useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";

function developerViewSelectValue(pathname: string): string {
  if (pathname.startsWith("/admin")) return "/admin";
  if (pathname.startsWith("/staff")) return "/staff";
  if (pathname.startsWith("/account")) return "/account";
  return "/dev/dashboard";
}

export const meta: MetaFunction = () => [{ title: "My account | Pivot Parlor" }];

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "customer", env.API_URL);
  const token = getSessionToken(request) as string;
  const api = createApiClient(env.API_URL, token);
  const me = await api.get<{
    id: string;
    name: string | null;
    email: string;
    phone?: string | null;
    role: string;
  }>("/auth/me");
  return json({ me });
}

export default function AccountLayout() {
  const { me } = useLoaderData<typeof loader>();
  const isDeveloper = me.role === "developer";
  const { pathname } = useLocation();
  const navigate = useNavigate();

  return (
    <div className="flex min-h-screen flex-col bg-dark">
      <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-white/10 bg-dark px-4 sm:px-6">
        <Link to="/account" className="font-heading text-lg font-bold text-white">
          Pivot <span className="text-gold">Parlor</span>
        </Link>
        <div className="flex min-w-0 flex-1 items-center justify-end gap-3 sm:gap-4">
          {isDeveloper ? (
            <label className="hidden items-center gap-2 sm:flex">
              <span className="shrink-0 text-xs text-white/60">Switch View</span>
              <select
                className="max-w-[11rem] rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-xs text-white focus:border-gold/50 focus:outline-none focus:ring-1 focus:ring-gold/40"
                value={developerViewSelectValue(pathname)}
                onChange={(e) => navigate(e.target.value)}
              >
                <option className="bg-dark text-white" value="/dev/dashboard">
                  Developer Dashboard
                </option>
                <option className="bg-dark text-white" value="/admin">
                  Admin View
                </option>
                <option className="bg-dark text-white" value="/staff">
                  Staff View
                </option>
                <option className="bg-dark text-white" value="/account">
                  Customer View
                </option>
              </select>
            </label>
          ) : null}
          <span className="hidden truncate text-sm text-white/60 sm:inline">{me.email}</span>
          <Form method="post" action="/logout">
            <button
              type="submit"
              className="tap-target rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-white/10"
            >
              Log out
            </button>
          </Form>
        </div>
      </header>
      {isDeveloper ? (
        <div className="border-b border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100 sm:px-6">
          <span className="font-medium text-amber-200">Developer View</span>
          {": "}
          you are viewing this as <strong className="text-white">customer</strong> dashboard.{" "}
          <Link to="/dev/dashboard" className="text-gold underline decoration-gold/60 hover:decoration-gold">
            Back to developer dashboard
          </Link>
        </div>
      ) : null}
      <main className="flex-1 px-4 py-6 sm:px-6 sm:py-8">
        <Outlet context={{ me }} />
      </main>
    </div>
  );
}
