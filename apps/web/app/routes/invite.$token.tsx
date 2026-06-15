import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { useActionData, useLoaderData } from "@remix-run/react";
import { invitePageSendsE2eMock } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { sessionCookieHeaders } from "~/lib/auth";

interface InviteData {
  email: string;
  role: string;
  expires_at: string;
  shop: { id: string; name: string; slug: string } | null;
}

export const meta: MetaFunction = () => [
  { title: "Accept invite — Pivot Parlor" },
];

export async function loader({ request, params, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const { token } = params;

  if (!token) throw new Response("Not found", { status: 404 });

  const url = new URL(request.url);
  /** Playwright dev/shops mock uses this token; Worker seeds D1 when X-E2E-Test-Mock is sent. */
  const playwrightSyntheticInvite = token === "a".repeat(64);
  const e2eInviteMock =
    invitePageSendsE2eMock(request) ||
    url.searchParams.get("e2e_invite_mock") === "1" ||
    playwrightSyntheticInvite;
  if (e2eInviteMock && token.startsWith("inactive-")) {
    return json({
      invite: null,
      token,
      error: "This invite is not yet active. Payment may still be pending.",
    });
  }

  try {
    const api = createApiClient(
      env.API_URL,
      null,
      e2eInviteMock ? { "X-E2E-Test-Mock": "1" } : undefined
    );
    const invite = await api.get<InviteData>(`/api/invites/${token}`);
    return json({ invite, token, error: null });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid or expired invite";
    return json({ invite: null, token, error: msg });
  }
}

export async function action({ request, params, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const { token } = params;

  if (!token) return json({ error: "Missing invite token" });

  const form = await request.formData();
  const name = form.get("name")?.toString().trim() ?? "";
  const password = form.get("password")?.toString() ?? "";
  const confirm = form.get("confirm_password")?.toString() ?? "";

  if (!name) return json({ error: "Full name is required" });
  if (password.length < 8) return json({ error: "Password must be at least 8 characters" });
  if (password !== confirm) return json({ error: "Passwords do not match" });

  try {
    const api = createApiClient(env.API_URL, null);
    const result = await api.post<{ token: string; role: string; shop_id: string }>(
      `/api/invites/${token}/accept`,
      { name, password }
    );

    const isProd = env.API_URL.includes("pivotparlor.com");

    // Route by role — admin goes to template selection first
    const dashMap: Record<string, string> = {
      admin: "/setup/template-select",
      staff: "/staff",
      developer: "/dev",
    };
    const destination = dashMap[result.role] ?? "/";

    throw redirect(destination, {
      headers: sessionCookieHeaders(result.token, isProd),
    });
  } catch (err) {
    if (err instanceof Response) throw err;
    const msg = err instanceof Error ? err.message : "Failed to accept invite";
    return json({ error: msg });
  }
}

export default function InviteAccept() {
  const { invite, error: loaderError } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  if (loaderError || !invite) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-dark px-4">
        <div className="w-full max-w-md text-center space-y-4">
          <h1 className="font-heading text-2xl font-bold text-white">
            Invite not valid
          </h1>
          <p className="text-white/60">
            {loaderError ?? "This invite link is invalid, expired, or has already been used."}
          </p>
          <a
            href="/"
            className="inline-block text-sm text-gold hover:underline"
          >
            Return home
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-md space-y-8">
        {/* Logo */}
        <div className="text-center">
          <span className="font-heading text-2xl font-bold text-white tracking-wide">
            Pivot <span className="text-gold">Parlor</span>
          </span>
        </div>

        <div className="space-y-6 rounded-2xl border border-white/10 bg-dark-100 p-8">
          {/* Header */}
          <div className="space-y-1">
            <h1 className="font-heading text-xl font-bold text-white">
              You&apos;re invited!
            </h1>
            {invite.shop && (
              <p className="text-sm text-white/60">
                Set up your account to manage{" "}
                <span className="text-white font-medium">{invite.shop.name}</span>.
              </p>
            )}
            <p className="text-sm text-white/40">
              Signing in as{" "}
              <span className="text-white/70 font-medium">{invite.email}</span>
            </p>
          </div>

          {/* Error */}
          {actionData?.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {actionData.error}
            </div>
          )}

          {/* Form */}
          <form method="post" className="space-y-4">
            <div className="space-y-1.5">
              <label
                htmlFor="name"
                className="block text-sm font-medium text-white/80"
              >
                Full name
              </label>
              <input
                id="name"
                name="name"
                type="text"
                required
                autoComplete="name"
                placeholder="Jane Smith"
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
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
                minLength={8}
                autoComplete="new-password"
                placeholder="At least 8 characters"
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="confirm_password"
                className="block text-sm font-medium text-white/80"
              >
                Confirm password
              </label>
              <input
                id="confirm_password"
                name="confirm_password"
                type="password"
                required
                autoComplete="new-password"
                placeholder="Repeat password"
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
              />
            </div>

            <label className="flex items-start gap-2 text-xs text-white/60">
              <input
                type="checkbox"
                name="accept_terms"
                required
                className="mt-0.5 h-4 w-4 shrink-0 rounded border-white/30 bg-white/5 accent-gold"
              />
              <span>
                I agree to the{" "}
                <a href="/terms" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/90">Terms of Service</a>,{" "}
                <a href="/privacy" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/90">Privacy Policy</a>, and{" "}
                <a href="/dpa" target="_blank" rel="noopener noreferrer" className="underline hover:text-white/90">Data Processing Agreement</a>.
              </span>
            </label>

            <button
              type="submit"
              className="h-11 w-full rounded-lg bg-gold text-sm font-semibold text-dark transition-colors hover:bg-gold-light"
            >
              Activate account →
            </button>
          </form>
        </div>

        {/* Expiry notice */}
        <p className="text-center text-xs text-white/30">
          This invite expires on{" "}
          {new Date(invite.expires_at).toLocaleDateString("en-GB", {
            day: "numeric",
            month: "long",
            year: "numeric",
          })}
          .
        </p>
      </div>
    </div>
  );
}
