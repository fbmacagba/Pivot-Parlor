import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { useActionData, useLoaderData } from "@remix-run/react";
import { createApiClient } from "~/lib/api";
import { buildSessionCookie, getSessionToken } from "~/lib/auth";

export const meta: MetaFunction = () => [{ title: "Sign in | Pivot Parlor" }];

/** Same-origin path only; blocks open redirects. */
function safeRedirectPath(raw: string | null): string | null {
  if (!raw || typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  if (t.includes(":") || t.includes("@")) return null;
  return t;
}

function dashboardForRole(role: string): string {
  switch (role) {
    case "developer":
      return "/dev/dashboard";
    case "admin":
      return "/admin";
    case "staff":
      return "/staff";
    case "customer":
      return "/account";
    default:
      return "/login";
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const url = new URL(request.url);
  const redirectParam = safeRedirectPath(url.searchParams.get("redirect"));

  const token = getSessionToken(request);
  if (token) {
    try {
      const api = createApiClient(env.API_URL, token);
      const me = await api.get<{ id: string; role: string }>("/auth/me");
      const dest = redirectParam ?? dashboardForRole(me.role);
      return redirect(dest);
    } catch {
      /* invalid or expired session — show login */
    }
  }

  return json({ redirectTo: redirectParam ?? "" });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string; APP_DOMAIN?: string };
  const form = await request.formData();
  const email = (form.get("email") as string | null) ?? "";
  const password = (form.get("password") as string | null) ?? "";
  const redirectRaw = form.get("redirect") as string | null;
  const redirectAfter = safeRedirectPath(redirectRaw);

  if (!email || !password) {
    return json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }

  const api = createApiClient(env.API_URL);

  try {
    const result = await api.post<{
      token: string;
      role: string;
      shop_id?: string | null;
    }>("/auth/login", { email, password });

    const role = result.role;
    const defaultDash = dashboardForRole(role);
    const dest =
      redirectAfter && canUseRedirectForRole(redirectAfter, role)
        ? redirectAfter
        : defaultDash;

    const isProd =
      (env.APP_DOMAIN ?? "").trim() !== "" &&
      env.APP_DOMAIN !== "localhost";

    return redirect(dest, {
      headers: {
        "Set-Cookie": buildSessionCookie(result.token, isProd),
      },
    });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Invalid email or password.";
    return json({ error: msg }, { status: 401 });
  }
}

/** Optional ?redirect= must not send staff to /dev-only areas, etc. */
function canUseRedirectForRole(path: string, role: string): boolean {
  if (path.startsWith("/dev") && role !== "developer") return false;
  if (path.startsWith("/admin") && role !== "admin") return false;
  if (path.startsWith("/staff") && role !== "staff") return false;
  if (path.startsWith("/account") && role !== "customer") return false;
  return true;
}

export default function LoginPage() {
  const { redirectTo } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0D0D0D] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-heading text-2xl font-bold text-white">
            Pivot <span className="text-[#C9A84C]">Parlor</span>
          </p>
          <h1 className="mt-2 text-xl font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-white/60">
            Use your Pivot Parlor account to continue.
          </p>
        </div>

        <form
          method="post"
          action="/login"
          className="space-y-4 rounded-2xl border border-white/10 bg-[#111111] p-8"
        >
          <input type="hidden" name="redirect" value={redirectTo} />

          {data && "error" in data && data.error ? (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {data.error}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="block text-sm font-medium text-white/80"
            >
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="block h-10 w-full rounded-lg border border-white/20 bg-black/20 px-3 text-sm text-white placeholder:text-white/40 focus:border-[#C9A84C] focus:outline-none focus:ring-2 focus:ring-[#C9A84C]"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="block text-sm font-medium text-white/80"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="block h-10 w-full rounded-lg border border-white/20 bg-black/20 px-3 text-sm text-white placeholder:text-white/40 focus:border-[#C9A84C] focus:outline-none focus:ring-2 focus:ring-[#C9A84C]"
            />
          </div>

          <button
            type="submit"
            className="flex h-10 w-full items-center justify-center rounded-lg bg-[#C9A84C] text-sm font-semibold text-black transition-colors hover:bg-[#e1c66a]"
          >
            Sign in
          </button>
        </form>
      </div>
    </div>
  );
}
