import { useLoaderData, useFetcher, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Button } from "~/components/ui/Button";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";

interface ConnectStatus {
  account_id: string | null;
  onboarded: boolean;
  charges_enabled: boolean | null;
  payouts_enabled: boolean | null;
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!user.shop_id || !token) {
    return json({ shopId: null as string | null, status: null as ConnectStatus | null, error: "no_shop" as const });
  }
  const api = createApiClient(env.API_URL, token);
  let status: ConnectStatus | null = null;
  try {
    status = (await api.get(`/api/shops/${user.shop_id}/connect/status`)) as ConnectStatus;
  } catch {
    status = null;
  }
  return json({ shopId: user.shop_id, status, error: null as null });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);
  const user = await requireRole(request, "admin", env.API_URL);
  if (!user.shop_id) return json({ ok: false, error: "No shop assigned" }, 400);

  const origin = new URL(request.url).origin;
  const api = createApiClient(env.API_URL, token);
  try {
    const data = (await api.post(`/api/shops/${user.shop_id}/connect/onboard`, {
      return_url: `${origin}/admin/payments?connect=return`,
      refresh_url: `${origin}/admin/payments?connect=refresh`,
    })) as { url: string };
    return redirect(data.url);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not start Stripe onboarding";
    return json({ ok: false, error: msg }, 400);
  }
}

export default function AdminPayments() {
  const { status, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const [searchParams] = useSearchParams();
  const justReturned = searchParams.get("connect") === "return";
  const busy = fetcher.state !== "idle";

  if (error === "no_shop") {
    return (
      <div className="p-6">
        <p className="text-white/60 text-sm">No shop is assigned to this account.</p>
      </div>
    );
  }

  const onboarded = status?.onboarded === true;
  const started = Boolean(status?.account_id);

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="font-heading text-2xl text-white mb-1">Payments</h1>
      <p className="text-white/50 text-sm mb-6">
        Connect your Stripe account so customers can pay deposits and you receive payouts directly.
      </p>

      <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-white font-medium">
              {onboarded
                ? "Stripe account connected"
                : started
                  ? "Stripe onboarding in progress"
                  : "Stripe account not connected"}
            </p>
            <p className="text-white/50 text-sm mt-1">
              {onboarded
                ? "Deposits and payouts are enabled for this shop."
                : justReturned
                  ? "Thanks. Stripe is reviewing your details; this page updates automatically once your account is enabled."
                  : "You will be redirected to Stripe to verify your business details. It takes about 5 minutes."}
            </p>
          </div>
          <span
            className={
              onboarded
                ? "shrink-0 rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-medium text-emerald-300"
                : "shrink-0 rounded-full bg-amber-500/15 px-3 py-1 text-xs font-medium text-amber-300"
            }
          >
            {onboarded ? "Active" : started ? "Pending" : "Not set up"}
          </span>
        </div>

        {!onboarded && (
          <fetcher.Form method="post" className="mt-5">
            <Button type="submit" disabled={busy}>
              {busy ? "Redirecting to Stripe..." : started ? "Continue Stripe setup" : "Set up payments with Stripe"}
            </Button>
            {fetcher.data && !fetcher.data.ok && (
              <p className="text-red-400 text-sm mt-3">{fetcher.data.error}</p>
            )}
          </fetcher.Form>
        )}
      </div>
    </div>
  );
}
