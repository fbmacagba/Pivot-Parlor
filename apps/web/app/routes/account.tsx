import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Form, Link, Outlet, useLoaderData } from "@remix-run/react";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";

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
    role: string;
  }>("/auth/me");
  return json({ me });
}

export default function AccountLayout() {
  const { me } = useLoaderData<typeof loader>();

  return (
    <div className="flex min-h-screen flex-col bg-dark">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-dark px-6">
        <Link to="/account" className="font-heading text-lg font-bold text-white">
          Pivot <span className="text-gold">Parlor</span>
        </Link>
        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-white/60 sm:inline">{me.email}</span>
          <Form method="post" action="/logout">
            <button
              type="submit"
              className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-white/10"
            >
              Log out
            </button>
          </Form>
        </div>
      </header>
      <main className="flex-1 overflow-y-auto px-6 py-8">
        <Outlet context={{ me }} />
      </main>
    </div>
  );
}
