import { Link, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useEffect, useState } from "react";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";

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

export default function BookingConfirm() {
  const { slug, booking, bookingId, awaitingPayment, apiUrl } = useLoaderData<typeof loader>();
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
      <div className="flex min-h-screen items-center justify-center bg-dark px-4">
        <div className="w-full max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <Loader2 className="h-16 w-16 animate-spin text-gold" />
          </div>
          <h1 className="font-heading text-3xl font-bold text-white">Finalising your payment…</h1>
          <p className="mt-3 text-white/60">
            Your deposit went through — we&apos;re confirming your booking. This normally takes a few
            seconds. You&apos;ll also receive a confirmation email.
          </p>
          {pollTimedOut && (
            <p className="mt-3 text-sm text-amber-300/80">
              This is taking longer than usual. Your payment is safe — the confirmation email will
              arrive once processing completes, or contact the shop quoting the reference below.
            </p>
          )}
          {bookingId && <p className="mt-2 font-mono text-xs text-white/30">Ref: {bookingId}</p>}
        </div>
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-dark px-4">
        <div className="w-full max-w-md text-center">
          <div className="mb-6 flex justify-center">
            <XCircle className="h-16 w-16 text-red-400" />
          </div>
          <h1 className="font-heading text-3xl font-bold text-white">Booking not completed</h1>
          <p className="mt-3 text-white/60">
            This booking was cancelled before payment completed. No money has been taken — you can
            book again below.
          </p>
          <div className="mt-8">
            <Button asChild size="lg">
              <Link to={`/${slug}/book`}>Book again</Link>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-md text-center">
        <div className="mb-6 flex justify-center">
          <CheckCircle className="h-16 w-16 text-emerald-400" />
        </div>
        <h1 className="font-heading text-3xl font-bold text-white">Booking confirmed!</h1>
        <p className="mt-3 text-white/60">
          We&apos;ve sent a confirmation to your email. You&apos;ll receive a reminder before your appointment.
        </p>
        {bookingId && (
          <p className="mt-2 font-mono text-xs text-white/30">Ref: {bookingId}</p>
        )}
        <div className="mt-8 flex flex-col gap-3">
          <Button asChild size="lg">
            <a
              href={`https://calendar.google.com/calendar/r/eventedit?text=Appointment`}
              target="_blank"
              rel="noopener noreferrer"
            >
              Add to calendar
            </a>
          </Button>
          <Button asChild variant="ghost">
            <Link to={`/${slug}`}>Back to shop</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
