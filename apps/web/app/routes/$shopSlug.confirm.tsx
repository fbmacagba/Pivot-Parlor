import { Link, useLoaderData } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { CheckCircle } from "lucide-react";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const url = new URL(request.url);
  const bookingId = url.searchParams.get("id");
  let booking = null;

  if (bookingId) {
    try {
      booking = await createApiClient(env.API_URL).get(`/api/bookings/${bookingId}`);
    } catch { /* empty */ }
  }

  return json({ slug: params.shopSlug, booking, bookingId });
}

export default function BookingConfirm() {
  const { slug, bookingId } = useLoaderData<typeof loader>();

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
