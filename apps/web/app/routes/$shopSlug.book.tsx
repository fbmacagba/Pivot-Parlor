import { Form, useFetcher, useLoaderData, useNavigation, useRouteLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { useState } from "react";
import { createApiClient } from "~/lib/api";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import { siteDataForChrome } from "~/lib/shopCommercialChrome";
import {
  ThemedButton,
  ThemedInput,
  ThemedTextarea,
  lightDark,
  platformFallbackVars,
} from "~/components/ThemedBookingControls";
import type { Service } from "@repo/types";
import { formatPence, isPortfolioDemoShop, PORTFOLIO_DEMO_ERROR } from "@repo/utils";
import { portfolioDemoServices, portfolioDemoStaff, getPortfolioDemoSlots } from "~/lib/portfolioDemo";
import type { loader as shopLoader, ShopSiteData } from "./$shopSlug";

interface Staff { id: string; display_name: string; bio?: string }
interface Slot { staff_id: string; start_time: string; end_time: string; is_available: boolean }

export const meta: MetaFunction = ({ matches, params }) => {
  const data = matches.find(m => m.id === "routes/$shopSlug")?.data as { shop?: { name?: string } } | undefined;
  return [{ title: isPortfolioDemoShop(params.shopSlug) ? "Try a booking | FerdyM's Barber Shop demo" : `Book an appointment | ${data?.shop?.name || "Pivot Parlor"}` }];
};

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  if (isPortfolioDemoShop(params.shopSlug)) {
    const query = new URL(request.url).searchParams;
    return json({ slug: params.shopSlug!, services: portfolioDemoServices, staff: portfolioDemoStaff,
      slots: getPortfolioDemoSlots(query.get("date") || "", query.get("service_id") || "", query.get("staff_id") || "any"),
      shopTimezone: "Europe/London", deposit: null, paymentCancelled: false });
  }
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL);
  const url = new URL(request.url);
  const date = url.searchParams.get("date");
  const serviceId = url.searchParams.get("service_id");
  const staffId = url.searchParams.get("staff_id");

  // Returning from an abandoned Stripe deposit page: cancel the unpaid
  // booking straight away so its slot frees for an immediate retry (the
  // worker only honours pending+unpaid rows, so this cannot cancel real
  // bookings).
  const cancelledBookingId = url.searchParams.get("payment") === "cancelled"
    ? url.searchParams.get("booking")
    : null;
  if (cancelledBookingId) {
    try {
      await api.post(`/api/bookings/${cancelledBookingId}/abandon`, {});
    } catch { /* already released or paid — nothing to do */ }
  }

  let services: Service[] = [];
  let staff: Staff[] = [];
  let slots: Slot[] = [];
  let shopTimezone = "Europe/London";
  let deposit: { percent: number; min_pence: number } | null = null;

  try {
    const shopRes = await api.get<{ id: string; timezone?: string }>(`/api/shops/${params.shopSlug}`);
    shopTimezone = shopRes.timezone || "Europe/London";
    // Do not use Promise.all: /staff requires auth and would reject the whole loader, clearing services.
    const [svcResult, staffResult, settingsResult] = await Promise.allSettled([
      api.get<Service[]>(`/api/shops/${shopRes.id}/services`),
      api.get<Staff[]>(`/api/shops/${shopRes.id}/booking-staff`),
      api.get<{ deposits_enabled?: boolean; deposit_percent?: number; deposit_min_pence?: number }>(
        `/api/shops/${shopRes.id}/settings`
      ),
    ]);
    services = svcResult.status === "fulfilled" ? svcResult.value : [];
    staff = staffResult.status === "fulfilled" ? staffResult.value : [];
    if (settingsResult.status === "fulfilled" && settingsResult.value.deposits_enabled) {
      deposit = {
        percent: settingsResult.value.deposit_percent ?? 50,
        min_pence: settingsResult.value.deposit_min_pence ?? 500,
      };
    }
    // The slots endpoint requires date + service_id; a specific staff scopes
    // the result, "any" (no staff_id) returns all staff (deduped client-side).
    if (date && serviceId) {
      const staffParam =
        staffId && staffId !== "any" ? `&staff_id=${encodeURIComponent(staffId)}` : "";
      try {
        slots = await api.get<Slot[]>(
          `/api/shops/${shopRes.id}/slots?date=${encodeURIComponent(date)}&service_id=${encodeURIComponent(serviceId)}${staffParam}`
        );
      } catch {
        slots = [];
      }
    }
  } catch { /* empty */ }

  return json({
    slug: params.shopSlug,
    services,
    staff,
    slots,
    shopTimezone,
    deposit,
    paymentCancelled: Boolean(cancelledBookingId),
  });
}

export async function action({ params, request, context }: ActionFunctionArgs) {
  if (isPortfolioDemoShop(params.shopSlug)) return json({ success: false, error: PORTFOLIO_DEMO_ERROR }, { status: 403 });
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL);
  const form = await request.formData();

  const booking = await api.post<{ id: string; checkout_url?: string }>("/api/bookings", {
    shop_slug: params.shopSlug,
    service_id: form.get("service_id"),
    staff_id: form.get("staff_id"),
    date: form.get("date"),
    start_time: form.get("start_time"),
    customer_name: form.get("customer_name"),
    customer_email: form.get("customer_email"),
    customer_phone: form.get("customer_phone"),
    notes: form.get("notes"),
  });

  // Deposit-gated shop: hand the customer to the hosted Stripe page; the
  // success URL returns them to /confirm and the webhook confirms the booking.
  if (booking.checkout_url) {
    return redirect(booking.checkout_url);
  }

  return redirect(`/${params.shopSlug}/confirm?id=${booking.id}`);
}

const STEPS = ["Service", "Staff", "Date & Time", "Your Details", "Review"];

/** Deposit due for a service under the shop's config: percent of price with a
 *  floor, never more than the price itself (matches the worker's clamp). */
function depositDuePence(pricePence: number, cfg: { percent: number; min_pence: number }): number {
  return Math.min(pricePence, Math.max(Math.round((pricePence * cfg.percent) / 100), cfg.min_pence));
}

/**
 * The wizard renders inside the shop's AI-generated theme when the shop has a
 * live site (same chrome as terms/privacy/cookies: palette vars, curated
 * fonts, colorScheme, header/footer). Shops with no generated site keep the
 * platform-branded look, reproduced token-for-token by platformFallbackVars.
 */
export default function BookingRoute() {
  const layoutData = useRouteLoaderData<typeof shopLoader>("routes/$shopSlug");
  const site = (layoutData?.site ?? null) as ShopSiteData | null;

  if (layoutData?.shop && site) {
    return (
      <CommercialShopChrome
        site={siteDataForChrome(layoutData.shop.name, site, layoutData.shop.id)}
        settings={layoutData.settings ?? {}}
        shopSlug={layoutData.slug}
        bookingBar={false}
      >
        <BookingWizard key={layoutData.slug} />
      </CommercialShopChrome>
    );
  }
  return (
    <div className="pp-commercial" style={platformFallbackVars}>
      <BookingWizard />
    </div>
  );
}

function BookingWizard() {
  const { slug, services, staff, slots, shopTimezone, deposit, paymentCancelled } =
    useLoaderData<typeof loader>();
  const nav = useNavigation();
  const slotsFetcher = useFetcher<typeof loader>();
  const demo = isPortfolioDemoShop(slug);
  const [demoComplete, setDemoComplete] = useState(false);
  const [step, setStep] = useState(0);
  const [selection, setSelection] = useState({
    service: null as Service | null,
    staffId: "",
    date: "",
    slot: "",
    name: demo ? "Demo Guest" : "",
    email: demo ? "guest@example.com" : "",
    phone: "",
    notes: "",
  });

  // Slots come from the client-side fetcher once a date is picked; fall back to
  // the loader's slots. Dedupe by start_time (for "any staff", several staff can
  // be free at the same time) and keep only available ones.
  const rawSlots = (slotsFetcher.data?.slots ?? slots) as Slot[];
  const availableSlots = [
    ...new Map(rawSlots.filter((s) => s.is_available).map((s) => [s.start_time, s])).values(),
  ].sort((a, b) => a.start_time.localeCompare(b.start_time));

  if (demoComplete) return (
    <section className="mx-auto max-w-2xl px-4 py-16" role="status">
      <h1 className="text-3xl font-semibold">Demo complete</h1>
      <p className="mt-4">No appointment was booked. No payment was taken and no email was sent.</p>
      <p className="mt-2">This walkthrough used sample services, times and guest details.</p>
      <ThemedButton className="mt-6" onClick={() => { setDemoComplete(false); setStep(0); setSelection(p => ({ ...p, service: null, staffId: "", date: "", slot: "" })); }}>Try again</ThemedButton>
    </section>
  );

  return (
    <div className="min-h-screen bg-[color:var(--st-bg)] px-4 py-12 text-[color:var(--st-ink)] sm:px-6">
      <div className="mx-auto max-w-2xl">
        {paymentCancelled && (
          <div
            className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
            style={lightDark("#92400e", "#fde68a")}
          >
            Payment cancelled — your slot has been released. Pick a time below to book again.
          </div>
        )}
        {/* Progress bar */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-[color:var(--st-ink-50)]">Step {step + 1} of {STEPS.length}</p>
            <p className="text-sm font-medium text-[color:var(--st-ink)]">{STEPS[step]}</p>
          </div>
          <div className="h-1 w-full rounded-full bg-[color:var(--st-chip)]">
            <div
              className="h-1 rounded-full bg-[color:var(--color-accent)] transition-all"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-[color:var(--st-line-10)] bg-[color:var(--st-card)] p-8">
          {step === 0 && (
            <div className="space-y-4">
              <h2 className="font-heading text-2xl font-bold text-[color:var(--st-ink)]">Select a service</h2>
              {services.length === 0 ? (
                <p className="text-[color:var(--st-ink-60)]">No services available.</p>
              ) : (
                services.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { setSelection((p) => ({ ...p, service: s })); setStep(1); }}
                    className={`w-full rounded-xl border p-4 text-left transition-colors ${
                      selection.service?.id === s.id ? "border-[color:var(--color-accent)] bg-[color:var(--st-accent-10)]" : "border-[color:var(--st-line-10)] bg-[color:var(--st-bg)] hover:border-[color:var(--st-accent-40)]"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <p className="font-medium text-[color:var(--st-ink)]">{s.name}</p>
                      <p className="text-[color:var(--st-accent-text)] font-semibold">{formatPence(s.price_pence)}</p>
                    </div>
                    <p className="mt-0.5 text-sm text-[color:var(--st-ink-50)]">{s.durationMinutes} min</p>
                  </button>
                ))
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <h2 className="font-heading text-2xl font-bold text-[color:var(--st-ink)]">Select staff</h2>
              <button
                onClick={() => { setSelection((p) => ({ ...p, staffId: "any" })); setStep(2); }}
                className={`w-full rounded-xl border p-4 text-left transition-colors ${
                  selection.staffId === "any" ? "border-[color:var(--color-accent)] bg-[color:var(--st-accent-10)]" : "border-[color:var(--st-line-10)] bg-[color:var(--st-bg)] hover:border-[color:var(--st-accent-40)]"
                }`}
              >
                <p className="font-medium text-[color:var(--st-ink)]">Any available</p>
                <p className="text-sm text-[color:var(--st-ink-50)]">We&apos;ll assign the best available staff member</p>
              </button>
              {staff.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { setSelection((p) => ({ ...p, staffId: s.id })); setStep(2); }}
                  className={`flex w-full items-center gap-4 rounded-xl border p-4 text-left transition-colors ${
                    selection.staffId === s.id ? "border-[color:var(--color-accent)] bg-[color:var(--st-accent-10)]" : "border-[color:var(--st-line-10)] bg-[color:var(--st-bg)] hover:border-[color:var(--st-accent-40)]"
                  }`}
                >
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[color:var(--st-accent-20)] font-heading font-bold text-[color:var(--st-accent-text)]">
                    {s.display_name.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium text-[color:var(--st-ink)]">{s.display_name}</p>
                    {s.bio && <p className="text-sm text-[color:var(--st-ink-50)]">{s.bio}</p>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 className="font-heading text-2xl font-bold text-[color:var(--st-ink)]">Pick date & time</h2>
              <ThemedInput
                label="Date"
                type="date"
                value={selection.date}
                min={new Date().toISOString().slice(0, 10)}
                onChange={(e) => {
                  const date = e.target.value;
                  setSelection((p) => ({ ...p, date, slot: "" }));
                  if (date && selection.service) {
                    const staffParam =
                      selection.staffId && selection.staffId !== "any"
                        ? `&staff_id=${encodeURIComponent(selection.staffId)}`
                        : "";
                    slotsFetcher.load(
                      `/${slug}/book?date=${encodeURIComponent(date)}&service_id=${encodeURIComponent(selection.service.id)}${staffParam}`
                    );
                  }
                }}
              />

              {slotsFetcher.state === "loading" && (
                <p className="text-sm text-[color:var(--st-ink-60)]">Loading available slots…</p>
              )}

              {availableSlots.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-[color:var(--st-ink-80)] mb-2">Available slots</p>
                  <div className="grid grid-cols-3 gap-2">
                    {availableSlots.map((slot) => (
                      <button
                        key={slot.start_time}
                        onClick={() => setSelection((p) => ({ ...p, slot: slot.start_time }))}
                        className={`rounded-lg border py-2 text-sm transition-colors ${
                          selection.slot === slot.start_time ? "border-[color:var(--color-accent)] bg-[color:var(--st-accent-20)] text-[color:var(--st-accent-text)]" : "border-[color:var(--st-line-40)] text-[color:var(--st-ink-70)] hover:border-[color:var(--st-accent-40)]"
                        }`}
                      >
                        {formatSlotTime(slot.start_time, shopTimezone)}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selection.date && slotsFetcher.state !== "loading" && availableSlots.length === 0 && (
                <p className="text-sm text-[color:var(--st-ink-60)]">No slots available for this date.</p>
              )}

              <div className="flex gap-3">
                <ThemedButton variant="ghost" onClick={() => setStep(1)}>Back</ThemedButton>
                <ThemedButton disabled={!selection.slot} onClick={() => setStep(3)}>Next →</ThemedButton>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 className="font-heading text-2xl font-bold text-[color:var(--st-ink)]">Your details</h2>
              {demo ? (
                <div className="space-y-3">
                  <p>Sample guest details are supplied for this demonstration. Please do not enter personal information.</p>
                  <Row label="Name" value={selection.name} />
                  <Row label="Email" value={selection.email} />
                </div>
              ) : <>
              <ThemedInput label="Full name" value={selection.name} onChange={(e) => setSelection((p) => ({ ...p, name: e.target.value }))} required />
              <ThemedInput label="Email address" type="email" value={selection.email} onChange={(e) => setSelection((p) => ({ ...p, email: e.target.value }))} required />
              <ThemedInput label="Phone (optional)" type="tel" value={selection.phone} onChange={(e) => setSelection((p) => ({ ...p, phone: e.target.value }))} />
              <ThemedTextarea
                label="Notes (optional)"
                rows={3}
                value={selection.notes}
                onChange={(e) => setSelection((p) => ({ ...p, notes: e.target.value }))}
              />
              </>}
              <div className="flex gap-3">
                <ThemedButton variant="ghost" onClick={() => setStep(2)}>Back</ThemedButton>
                <ThemedButton disabled={!selection.name || !selection.email} onClick={() => setStep(4)}>Next →</ThemedButton>
              </div>
            </div>
          )}

          {step === 4 && (
            <Form method="post" className="space-y-4" onSubmit={demo ? (event) => { event.preventDefault(); setDemoComplete(true); } : undefined}>
              <input type="hidden" name="service_id" value={selection.service?.id ?? ""} />
              <input type="hidden" name="staff_id" value={selection.staffId} />
              <input type="hidden" name="date" value={selection.date} />
              <input type="hidden" name="start_time" value={selection.slot} />
              <input type="hidden" name="customer_name" value={selection.name} />
              <input type="hidden" name="customer_email" value={selection.email} />
              <input type="hidden" name="customer_phone" value={selection.phone} />
              <input type="hidden" name="notes" value={selection.notes} />

              <h2 className="font-heading text-2xl font-bold text-[color:var(--st-ink)]">Review & confirm</h2>
              <div className="space-y-3 rounded-xl border border-[color:var(--st-line-10)] bg-[color:var(--st-bg)] p-4 text-sm">
                <Row label="Service" value={selection.service?.name ?? "—"} />
                <Row label="Price" value={formatPence(selection.service?.price_pence ?? 0)} />
                {deposit && selection.service && (
                  <Row
                    label="Deposit due now"
                    value={formatPence(depositDuePence(selection.service.price_pence, deposit))}
                  />
                )}
                <Row label="Date" value={selection.date} />
                <Row label="Time" value={selection.slot ? formatSlotTime(selection.slot, shopTimezone) : "—"} />
                <Row label="Name" value={selection.name} />
                <Row label="Email" value={selection.email} />
              </div>
              {deposit && selection.service && (
                <p className="text-xs text-[color:var(--st-ink-50)]">
                  You&apos;ll be taken to a secure Stripe page to pay the deposit. The remaining balance is
                  settled at your appointment.
                </p>
              )}
              <div className="flex gap-3">
                <ThemedButton type="button" variant="ghost" onClick={() => setStep(3)}>Back</ThemedButton>
                <ThemedButton type="submit" disabled={nav.state === "submitting"} className="flex-1">
                  {nav.state === "submitting"
                    ? "Confirming…"
                    : deposit
                      ? "Continue to payment →"
                      : demo ? "Complete demo booking →" : "Confirm booking →"}
                </ThemedButton>
              </div>
              <p className="text-center text-xs text-[color:var(--st-ink-50)]">
                {demo ? "These are sample details. Nothing is reserved or sent. See our " : "We use these details only to manage your booking. See our "}
                <a
                  href={`/${slug}/privacy`}
                  className="underline hover:text-[color:var(--st-ink-80)]"
                >
                  Privacy Policy
                </a>
                .
              </p>
            </Form>
          )}
        </div>
      </div>
    </div>
  );
}

function formatSlotTime(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: tz,
  });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[color:var(--st-ink-50)]">{label}</span>
      <span className="font-medium text-[color:var(--st-ink)]">{value}</span>
    </div>
  );
}
