import { useLoaderData, useFetcher, useRevalidator, useSearchParams, data as json, redirect } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Button } from "~/components/ui/Button";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";
import { pageShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { usePolling } from "~/lib/usePolling";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Payments");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

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
  const shopId = pageShopId(request, user);
  // Connecting Stripe binds the shop's payouts to a bank account: that is the
  // owner's step. A developer sees the status but cannot start it.
  const canOnboard = user.role !== "developer";
  if (!shopId || !token) {
    return json({
      shopId: null as string | null,
      status: null as ConnectStatus | null,
      error: "no_shop" as const,
      canOnboard,
      loadError: false,
    });
  }
  const api = createApiClient(env.API_URL, token);
  let status: ConnectStatus | null = null;
  let loadError = false;
  try {
    status = (await api.get(`/api/shops/${shopId}/connect/status`)) as ConnectStatus;
  } catch {
    // Unknown is not "not connected": the page says it could not check.
    loadError = true;
  }
  return json({ shopId, status, error: null as null, canOnboard, loadError });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);
  const user = await requireRole(request, "admin", env.API_URL);
  if (user.role === "developer") {
    return json({ ok: false, error: "Only the shop's owner can connect its Stripe account." }, 403);
  }
  const shopId = pageShopId(request, user);
  if (!shopId) return json({ ok: false, error: "No shop assigned" }, 400);

  const origin = new URL(request.url).origin;
  const api = createApiClient(env.API_URL, token);
  try {
    const data = (await api.post(`/api/shops/${shopId}/connect/onboard`, {
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
  const { status, error, canOnboard, loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok: boolean; error?: string }>();
  const revalidator = useRevalidator();
  const [searchParams] = useSearchParams();
  const justReturned = searchParams.get("connect") === "return";
  const busy = fetcher.state !== "idle";

  const onboarded = status?.onboarded === true;
  const started = Boolean(status?.account_id);

  // While Stripe is still reviewing, look again every 15 seconds, so the page
  // turns to "connected" by itself as its copy promises.
  usePolling(() => revalidator.revalidate(), {
    intervalMs: 15_000,
    enabled: error !== "no_shop" && !loadError && started && !onboarded && !busy,
  });

  if (error === "no_shop") {
    return (
      <div className="space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Payments</h1>
        <p className="text-sm text-white/60">No shop is assigned to this account.</p>
      </div>
    );
  }

  if (loadError || !status) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Payments</h1>
        <LoadError what="your Stripe connection" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h1 className="mb-1 font-heading text-2xl font-bold text-white">Payments</h1>
      <p className="mb-6 text-sm text-white/60">
        Connect your Stripe account so customers can pay deposits and you receive payouts directly.
      </p>

      <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-white font-medium">
              {onboarded
                ? "Stripe account connected"
                : started
                  ? "Stripe onboarding in progress"
                  : "Stripe account not connected"}
            </p>
            <p className="mt-1 text-sm text-white/60" role="status">
              {onboarded
                ? "Deposits and payouts are enabled for this shop."
                : justReturned && started
                  ? "Thanks. Stripe is reviewing your details. This page checks every 15 seconds and updates by itself once your account is enabled."
                  : started
                    ? "Stripe still needs some details, or is reviewing them. This page checks every 15 seconds while it is open."
                    : "You will be redirected to Stripe to verify your business details. It takes about 5 minutes."}
            </p>
          </div>
          <StatusBadge
            status={onboarded ? "active" : started ? "pending" : "inactive"}
            label={onboarded ? "Active" : started ? "Pending" : "Not set up"}
            className="shrink-0"
          />
        </div>

        {!onboarded && !canOnboard && (
          <p className="mt-5 text-sm text-white/60">Only the shop&apos;s owner can connect its Stripe account.</p>
        )}
        {!onboarded && canOnboard && (
          <fetcher.Form method="post" className="mt-5">
            <Button type="submit" disabled={busy}>
              {busy ? "Redirecting to Stripe…" : started ? "Continue Stripe setup" : "Set up payments with Stripe"}
            </Button>
            {fetcher.data && !fetcher.data.ok && (
              <p role="alert" className="mt-3 text-sm text-red-400">{fetcher.data.error}</p>
            )}
          </fetcher.Form>
        )}
      </div>
    </div>
  );
}
