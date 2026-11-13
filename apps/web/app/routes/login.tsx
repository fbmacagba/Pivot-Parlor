import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Link, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import { createApiClient } from "~/lib/api";
import { getSessionToken, sessionCookieHeaders } from "~/lib/auth";
import { safeRedirectPath } from "~/lib/safeRedirect";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";

export const meta: MetaFunction = () => [{ title: "Sign in | Pivot Parlor" }];

/** Maps a known role to its dashboard. Returns null for an unrecognised role so
 *  callers never redirect to /login — which would loop forever for an already
 *  signed-in visitor whose role the frontend doesn't recognise. */
function dashboardForRole(role: string): string | null {
  switch (role) {
    case "developer": return "/dev/dashboard";
    case "admin": return "/admin";
    case "staff": return "/staff";
    case "customer": return "/account";
    default: return null;
  }
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const url = new URL(request.url);
  const redirectParam = safeRedirectPath(url.searchParams.get("redirect"));

  // When a visitor arrives from a shop site (?shop=<slug>), surface a safe
  // "back to shop" link so they aren't stranded on the global sign-in page.
  const shopParam = url.searchParams.get("shop");
  const backToShop = shopParam && /^[a-z0-9-]+$/.test(shopParam) ? shopParam : "";

  const token = getSessionToken(request);
  if (token) {
    try {
      const api = createApiClient(env.API_URL, token);
      const me = await api.get<{ id: string; role: string }>("/auth/me");
      const dest = redirectParam ?? dashboardForRole(me.role);
      // Unknown role => dest is null: fall through and render the form instead
      // of redirecting to /login (which would loop).
      if (dest) return redirect(dest);
    } catch {
      /* invalid or expired session — show login */
    }
  }

  return json({ redirectTo: redirectParam ?? "", backToShop });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string; APP_DOMAIN?: string };
  const form = await readFormData(request);
  if (!form) return json({ error: UNREADABLE_FORM }, { status: 400 });
  const email = (form.get("email") as string | null) ?? "";
  const password = (form.get("password") as string | null) ?? "";
  const redirectRaw = form.get("redirect") as string | null;
  const redirectAfter = safeRedirectPath(redirectRaw);

  if (!email || !password) {
    return json({ error: "Email and password are required." }, { status: 400 });
  }

  // Forward the E2E test header so the Worker can recognise fixture traffic
  // (it only honours it when E2E_FIXTURES=true, i.e. staging). Harmless in prod.
  const e2eMock = request.headers.get("X-E2E-Test-Mock");
  const api = createApiClient(
    env.API_URL,
    null,
    e2eMock ? { "X-E2E-Test-Mock": e2eMock } : undefined
  );

  try {
    const result = await api.post<{ token: string; role: string; shop_id?: string | null }>(
      "/auth/login",
      { email, password }
    );

    const role = result.role;
    // Unknown role falls back to "/" (a safe, non-looping landing).
    const defaultDash = dashboardForRole(role) ?? "/";
    const dest =
      redirectAfter && canUseRedirectForRole(redirectAfter, role)
        ? redirectAfter
        : defaultDash;

    const isProd =
      (env.APP_DOMAIN ?? "").trim() !== "" && env.APP_DOMAIN !== "localhost";

    return redirect(dest, { headers: sessionCookieHeaders(result.token, isProd) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Invalid email or password.";
    return json({ error: msg }, { status: 401 });
  }
}

/** Optional ?redirect= must not send users to the wrong role's areas. */
function canUseRedirectForRole(path: string, role: string): boolean {
  if (role === "developer") return true;
  if (path.startsWith("/dev") && role !== "developer") return false;
  if (path.startsWith("/admin") && role !== "admin") return false;
  if (path.startsWith("/staff") && role !== "staff") return false;
  if (path.startsWith("/account") && role !== "customer") return false;
  return true;
}

// ─── Social login button icons ────────────────────────────────────────────────

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

function FacebookIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="#1877F2">
      <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true" fill="#0A66C2">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
    </svg>
  );
}

// ─── Page component ───────────────────────────────────────────────────────────

export default function LoginPage() {
  const { redirectTo, backToShop } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle";

  const apiBase =
    typeof window !== "undefined"
      ? (window as unknown as { ENV?: { API_URL?: string } }).ENV?.API_URL ?? ""
      : "";

  // Social login URLs go to the Worker OAuth endpoints
  const socialBase = apiBase || "https://api.pivotparlor.com";
  const redirectQuery = redirectTo ? `?redirect=${encodeURIComponent(redirectTo)}` : "";

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-sm">
        {backToShop ? (
          <div className="mb-6">
            <Link
              to={`/${backToShop}`}
              className="inline-flex items-center gap-1 text-sm text-white/55 transition hover:text-gold"
            >
              <span aria-hidden>←</span> Back to shop
            </Link>
          </div>
        ) : null}
        {/* Header */}
        <div className="mb-8 text-center">
          <p className="font-heading text-2xl font-bold text-white">
            Pivot <span className="text-gold">Parlor</span>
          </p>
          <h1 className="mt-2 text-xl font-semibold text-white">Sign in</h1>
          <p className="mt-1 text-sm text-white/60">
            Use your Pivot Parlor account to continue.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-dark-100 p-8">
          {/* Social login buttons */}
          <div className="space-y-3">
            <a
              href={`${socialBase}/auth/google${redirectQuery}`}
              className="flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-white/40 bg-white/5 text-sm font-medium text-white transition hover:bg-white/10"
            >
              <GoogleIcon />
              Continue with Google
            </a>
            <a
              href={`${socialBase}/auth/facebook${redirectQuery}`}
              className="flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-white/40 bg-white/5 text-sm font-medium text-white transition hover:bg-white/10"
            >
              <FacebookIcon />
              Continue with Facebook
            </a>
            <a
              href={`${socialBase}/auth/linkedin${redirectQuery}`}
              className="flex h-10 w-full items-center justify-center gap-2.5 rounded-lg border border-white/40 bg-white/5 text-sm font-medium text-white transition hover:bg-white/10"
            >
              <LinkedInIcon />
              Continue with LinkedIn
            </a>
          </div>

          {/* Divider */}
          <div className="my-6 flex items-center gap-3">
            <div className="h-px flex-1 bg-white/10" />
            <span className="text-xs text-white/60">or continue with email</span>
            <div className="h-px flex-1 bg-white/10" />
          </div>

          {/* Email + password form */}
          <form method="post" action="/login" className="space-y-4">
            <input type="hidden" name="redirect" value={redirectTo} />

            {data && "error" in data && data.error ? (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {data.error}
              </div>
            ) : null}

            <div className="space-y-1.5">
              <label htmlFor="email" className="block text-sm font-medium text-white/80">
                Email address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                required
                autoComplete="email"
                className="block h-10 w-full rounded-lg border border-white/40 bg-black/20 px-3 text-sm text-white placeholder:text-white/60 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="password" className="block text-sm font-medium text-white/80">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="current-password"
                className="block h-10 w-full rounded-lg border border-white/40 bg-black/20 px-3 text-sm text-white placeholder:text-white/60 focus:border-gold focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="flex h-10 w-full items-center justify-center rounded-lg bg-gold text-sm font-semibold text-dark transition-colors hover:bg-gold-light disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-white/50">
          Admin and staff accounts are created by your shop manager.
        </p>
      </div>
    </div>
  );
}
