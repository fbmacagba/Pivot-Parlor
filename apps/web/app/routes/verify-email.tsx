// apps/web/app/routes/verify-email.tsx
// Landing page for the verify-email link (SEC-3). The loader consumes the
// single-use token against the worker; opening the link is the proof of
// inbox access, so no extra click is required.

import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Link, useLoaderData } from "@remix-run/react";

export const meta: MetaFunction = () => [{ title: "Verify email | Pivot Parlor" }];

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";

  if (!token) {
    return json({ ok: false, error: "This verification link is missing its token." });
  }

  try {
    const res = await fetch(`${env.API_URL}/auth/verify-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; error?: string }
      | null;
    if (res.ok && data?.success) {
      return json({ ok: true, error: "" });
    }
    return json({
      ok: false,
      error: data?.error ?? "This verification link is invalid or has expired.",
    });
  } catch {
    return json({ ok: false, error: "Something went wrong. Please try again in a moment." });
  }
}

export default function VerifyEmail() {
  const { ok, error } = useLoaderData<typeof loader>();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-dark px-6 text-center">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-dark-100 p-8">
        {ok ? (
          <>
            <div className="mb-4 text-5xl" aria-hidden>
              ✅
            </div>
            <h1 className="font-heading text-2xl font-bold text-white">Email verified</h1>
            <p className="mt-3 text-sm text-white/50">
              Thanks, your email address is confirmed. You can now view and manage your bookings
              from your account.
            </p>
            <Link
              to="/account"
              className="mt-6 inline-block rounded-lg bg-gold px-6 py-2.5 text-sm font-semibold text-dark transition-colors hover:bg-gold-light"
            >
              Go to my account
            </Link>
          </>
        ) : (
          <>
            <div className="mb-4 text-5xl" aria-hidden>
              ⚠️
            </div>
            <h1 className="font-heading text-2xl font-bold text-white">Link not valid</h1>
            <p className="mt-3 text-sm text-white/50">{error}</p>
            <p className="mt-3 text-sm text-white/50">
              You can request a fresh link from your account page.
            </p>
            <Link
              to="/account"
              className="mt-6 inline-block rounded-lg bg-gold px-6 py-2.5 text-sm font-semibold text-dark transition-colors hover:bg-gold-light"
            >
              Go to my account
            </Link>
          </>
        )}
      </div>
    </main>
  );
}
