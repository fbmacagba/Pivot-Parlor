import { Link, useLoaderData, useRouteLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useEffect, useState } from "react";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import type { ReactNode } from "react";
import { createApiClient } from "~/lib/api";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import { siteDataForChrome } from "~/lib/shopCommercialChrome";
import { ThemedButton, lightDark, platformFallbackVars } from "~/components/ThemedBookingControls";
import { BookingConfirmMap } from "~/components/BookingConfirmMap";
import type { loader as shopLoader, ShopSiteData } from "./$shopSlug";

type BookingStatus = {
  id: string;
  status: string;
  deposit_pence?: number;
  deposit_paid?: boolean;
};

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const url = new URL(request.url);
  const bookingId = url.searchParams.get("id");
  // paid=1 = returning from the Stripe deposit page; the webhook may still be
  // settling, so the client polls until the booking flips to confirmed.
  const awaitingPayment = url.searchParams.get("paid") === "1";
  let booking: BookingStatus | null = null;

  if (bookingId) {
    try {
      booking = await createApiClient(env.API_URL).get<BookingStatus>(`/api/bookings/${bookingId}`);
    } catch { /* empty */ }
  }

  return json({
    slug: params.shopSlug,
    booking,
    bookingId,
    awaitingPayment,
    apiUrl: env.API_URL,
  });
}

/** Shared themed shell: shop chrome when the shop has a live site, the
 *  platform-branded fallback otherwise — same pattern as /book. */
function ConfirmShell({ children }: { children: ReactNode }) {
  const layoutData = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  const site = (layoutData?.site ?? null) as ShopSiteData | null;

  const shell = (
    <div className="flex min-h-screen items-center justify-center bg-[color:var(--st-bg)] px-4 text-[color:var(--st-ink)]">
      <div className="w-full max-w-md text-center">{children}</div>
    </div>
  );

  if (layoutData?.shop && site) {
    return (
      <CommercialShopChrome
        site={siteDataForChrome(layoutData.shop.name, site, layoutData.shop.id)}
        settings={layoutData.settings ?? {}}
        shopSlug={layoutData.slug}
      >
        {shell}
      </CommercialShopChrome>
    );
  }
  return (
    <div className="pp-commercial" style={platformFallbackVars}>
      {shell}
    </div>
  );
}

export default function BookingConfirm() {
  const { slug, booking, bookingId, awaitingPayment, apiUrl } = useLoaderData<typeof loader>();
  const layoutData = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  const shopAddress = layoutData?.settings?.address?.trim() || null;
  const [status, setStatus] = useState<string>(booking?.status ?? "unknown");
  const [pollTimedOut, setPollTimedOut] = useState(false);

  // Poll while the deposit webhook settles (returns from Stripe land here a
  // second or two before payment_intent.succeeded is delivered).
  const settling = awaitingPayment && status === "pending";
  useEffect(() => {
    if (!settling || !bookingId) return;
    let cancelled = false;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      try {
        const r = await fetch(`${apiUrl}/api/bookings/${bookingId}`);
        const j = (await r.json()) as { success?: boolean; data?: BookingStatus };
        if (!cancelled && j.success && j.data?.status) setStatus(j.data.status);
      } catch { /* transient — keep polling */ }
    };
    void tick();
    const id = setInterval(() => {
      if (tries >= 30) {
        clearInterval(id);
        if (!cancelled) setPollTimedOut(true);
        return;
      }
      void tick();
    }, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [settling, bookingId, apiUrl]);

  if (settling) {
    return (
      <ConfirmShell>
        <div className="mb-6 flex justify-center">
          <Loader2 className="h-16 w-16 animate-spin text-[color:var(--st-accent-text)]" />
        </div>
        <h1 className="font-heading text-3xl font-bold text-[color:var(--st-ink)]">Finalising your payment…</h1>
        <p className="mt-3 text-[color:var(--st-ink-60)]">
          Your deposit went through — we&apos;re confirming your booking. This normally takes a few
          seconds. You&apos;ll also receive a confirmation email.
        </p>
        {pollTimedOut && (
          <p
            className="mt-3 text-sm text-amber-300/80"
            style={lightDark("#92400e", "rgba(252, 211, 77, 0.8)")}
          >
            This is taking longer than usual. Your payment is safe — the confirmation email will
            arrive once processing completes, or contact the shop quoting the reference below.
          </p>
        )}
        {bookingId && <p className="mt-2 font-mono text-xs text-[color:var(--st-ink-50)]">Ref: {bookingId}</p>}
      </ConfirmShell>
    );
  }

  if (status === "cancelled") {
    return (
      <ConfirmShell>
        <div className="mb-6 flex justify-center">
          <XCircle className="h-16 w-16 text-red-400" style={lightDark("#dc2626", "#f87171")} />
        </div>
        <h1 className="font-heading text-3xl font-bold text-[color:var(--st-ink)]">Booking not completed</h1>
        <p className="mt-3 text-[color:var(--st-ink-60)]">
          This booking was cancelled before payment completed. No money has been taken — you can
          book again below.
        </p>
        <div className="mt-8">
          <ThemedButton asChild size="lg">
            <Link to={`/${slug}/book`}>Book again</Link>
          </ThemedButton>
        </div>
      </ConfirmShell>
    );
  }

  return (
    <ConfirmShell>
      <div className="mb-6 flex justify-center">
        <CheckCircle className="h-16 w-16 text-emerald-400" style={lightDark("#059669", "#34d399")} />
      </div>
      <h1 className="font-heading text-3xl font-bold text-[color:var(--st-ink)]">Booking confirmed!</h1>
      <p className="mt-3 text-[color:var(--st-ink-60)]">
        We&apos;ve sent a confirmation to your email. You&apos;ll receive a reminder before your appointment.
      </p>
      {bookingId && (
        <p className="mt-2 font-mono text-xs text-[color:var(--st-ink-50)]">Ref: {bookingId}</p>
      )}
      {shopAddress ? <BookingConfirmMap address={shopAddress} /> : null}
      <div className="mt-8 flex flex-col gap-3">
        <ThemedButton asChild size="lg">
          <a
            href={`https://calendar.google.com/calendar/r/eventedit?text=Appointment`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Add to calendar
          </a>
        </ThemedButton>
        <ThemedButton asChild variant="ghost">
          <Link to={`/${slug}`}>Back to shop</Link>
        </ThemedButton>
      </div>
    </ConfirmShell>
  );
}
