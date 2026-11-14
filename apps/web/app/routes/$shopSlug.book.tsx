import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRouteLoaderData,
  useSearchParams,
} from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { useEffect, useRef, useState } from "react";
import { createApiClient } from "~/lib/api";
import type { ApiClient } from "~/lib/api";
import { requireShopSlug } from "~/lib/shopSlug";
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
import { formatPence, isPortfolioDemoShop, PORTFOLIO_DEMO_ERROR, PORTFOLIO_DEMO_SLUG, portfolioDemoForSlug } from "@repo/utils";
import { portfolioDemoServices, portfolioDemoStaff } from "~/lib/portfolioDemo";
import { demoSlots, openingWindow, weekdayName } from "~/lib/demoBooking";
import { formatDay, formatTime, shopToday } from "~/lib/dateFormat";
import { restorableDay, restoredStep, skipRevalidationForWizardParams, wizardSearch } from "~/lib/bookingUrl";
import type { loader as shopLoader, ShopSiteData } from "./$shopSlug";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";

interface Staff { id: string; display_name: string; bio?: string; avatar_url?: string; speciality?: string }
interface Slot { staff_id: string; start_time: string; end_time: string; is_available: boolean }

export const meta: MetaFunction = ({ matches, params }) => {
  const data = matches.find(m => m.id === "routes/$shopSlug")?.data as { shop?: { name?: string } } | undefined;
  const name = data?.shop?.name || "Pivot Parlor";
  return isPortfolioDemoShop(params.shopSlug)
    ? [{ title: `Try a booking | ${name} demo` }, { name: "robots", content: "noindex, nofollow" }]
    : [{ title: `Book an appointment | ${name}` }];
};

/** Only ids that exist in the lists this page loaded can be preselected. The
 *  wizard's own place (team "any", the day, the step) is restored from the
 *  URL it keeps; see lib/bookingUrl. `today` is the shop's (shopToday): from
 *  midnight to 1am in British Summer Time, UTC's would still be yesterday. */
function preselect(url: URL, services: Array<{ id: string }>, staff: Array<{ id: string }>, today: string) {
  const serviceId = url.searchParams.get("serviceId") ?? "";
  const staffId = url.searchParams.get("staffId") ?? "";
  const preselectServiceId = services.some((s) => s.id === serviceId) ? serviceId : "";
  const preselectStaffId =
    preselectServiceId && staffId === "any" ? "any" : staff.some((s) => s.id === staffId) ? staffId : "";
  const preselectDay =
    preselectServiceId && preselectStaffId ? restorableDay(url.searchParams.get("day"), today) : "";
  return {
    // The earliest day the date picker offers. Sent from here so the server's
    // page and the browser's agree.
    today,
    preselectServiceId,
    preselectStaffId,
    preselectDay,
    preselectStep: restoredStep({
      stepParam: url.searchParams.get("step"),
      hasService: Boolean(preselectServiceId),
      hasStaff: Boolean(preselectStaffId),
    }),
  };
}

// Recording the wizard's place in the URL reloads nothing (and a demo makes
// no extra request); every other navigation or submission revalidates.
export const shouldRevalidate = skipRevalidationForWizardParams;

/**
 * Demo mode is READ-ONLY. It shows the fictional backing shop's own services
 * and team through public GETs (so site, chat and booking agree) and builds
 * synthetic times inside its opening hours. It never calls the slots,
 * booking, abandon or payment endpoints. Until the backing shop is
 * provisioned, the original demo URL keeps its static sample menu.
 */
async function demoBookingData(api: ApiClient, shopId: string, slug: string, url: URL) {
  let services: Service[] = [];
  let staff: Staff[] = [];
  let hoursJson: string | undefined;
  let shopTimezone = "Europe/London";
  let provisioned = false;
  try {
    const shop = await api.get<{ id: string; timezone?: string }>(`/api/shops/${shopId}`);
    if (shop.id === shopId) {
      provisioned = true;
      shopTimezone = shop.timezone || shopTimezone;
      const [svc, team, settings] = await Promise.allSettled([
        api.get<Service[]>(`/api/shops/${shopId}/services`),
        api.get<Staff[]>(`/api/shops/${shopId}/booking-staff`),
        api.get<{ hours_json?: string }>(`/api/shops/${shopId}/settings`),
      ]);
      services = svc.status === "fulfilled" ? svc.value : [];
      staff = team.status === "fulfilled" ? team.value : [];
      hoursJson = settings.status === "fulfilled" ? settings.value.hours_json : undefined;
    }
  } catch {
    /* not provisioned yet */
  }
  if (!provisioned && slug === PORTFOLIO_DEMO_SLUG) {
    services = portfolioDemoServices;
    staff = portfolioDemoStaff;
  }
  const date = url.searchParams.get("date") ?? "";
  const slots = date
    ? demoSlots({
        date,
        serviceId: url.searchParams.get("service_id") ?? "",
        staffId: url.searchParams.get("staff_id") ?? "any",
        services,
        staff,
        hoursJson,
        timeZone: shopTimezone,
      })
    : [];
  return {
    slug,
    services,
    staff,
    slots,
    shopTimezone,
    deposit: null,
    paymentCancelled: false,
    closedDay: date ? openingWindow(hoursJson, date) === null : false,
    ...preselect(url, services, staff, shopToday(shopTimezone)),
  };
}

export async function loader({ params, request, context }: LoaderFunctionArgs) {
  const slug = requireShopSlug(params);
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL);
  const url = new URL(request.url);
  const demo = portfolioDemoForSlug(slug);
  if (demo) return json(await demoBookingData(api, demo.shopId, slug, url));

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
    } catch { /* already released or paid: nothing to do */ }
  }

  let services: Service[] = [];
  let staff: Staff[] = [];
  let slots: Slot[] = [];
  let shopTimezone = "Europe/London";
  let deposit: { percent: number; min_pence: number } | null = null;
  let hoursJson: string | undefined;

  try {
    const shopRes = await api.get<{ id: string; timezone?: string }>(`/api/shops/${slug}`);
    shopTimezone = shopRes.timezone || "Europe/London";
    // Do not use Promise.all: /staff requires auth and would reject the whole loader, clearing services.
    const [svcResult, staffResult, settingsResult] = await Promise.allSettled([
      api.get<Service[]>(`/api/shops/${shopRes.id}/services`),
      api.get<Staff[]>(`/api/shops/${shopRes.id}/booking-staff`),
      api.get<{ deposits_enabled?: boolean; deposit_percent?: number; deposit_min_pence?: number; hours_json?: string }>(
        `/api/shops/${shopRes.id}/settings`
      ),
    ]);
    services = svcResult.status === "fulfilled" ? svcResult.value : [];
    staff = staffResult.status === "fulfilled" ? staffResult.value : [];
    if (settingsResult.status === "fulfilled") {
      hoursJson = settingsResult.value.hours_json;
      if (settingsResult.value.deposits_enabled) {
        deposit = {
          percent: settingsResult.value.deposit_percent ?? 50,
          min_pence: settingsResult.value.deposit_min_pence ?? 500,
        };
      }
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
    slug,
    services,
    staff,
    slots,
    shopTimezone,
    deposit,
    paymentCancelled: Boolean(cancelledBookingId),
    // Staff schedules decide real availability; the shop's published hours
    // only explain an empty day ("closed on Mondays").
    closedDay: date ? openingWindow(hoursJson, date) === null : false,
    ...preselect(url, services, staff, shopToday(shopTimezone)),
  });
}

const CONFIRM_FAILED =
  "We couldn't confirm that time. It may have just been taken. Choose another time and try again.";

export async function action({ params, request, context }: ActionFunctionArgs) {
  const slug = requireShopSlug(params);
  if (isPortfolioDemoShop(slug)) return json({ success: false, error: PORTFOLIO_DEMO_ERROR }, { status: 403 });
  const env = context.env as { API_URL: string };
  const api = createApiClient(env.API_URL);
  const form = await readFormData(request);
  if (!form) return json({ success: false, error: UNREADABLE_FORM }, { status: 400 });

  let booking: { id: string; checkout_url?: string };
  try {
    booking = await api.post<{ id: string; checkout_url?: string }>("/api/bookings", {
      shop_slug: slug,
      service_id: form.get("service_id"),
      staff_id: form.get("staff_id"),
      date: form.get("date"),
      start_time: form.get("start_time"),
      customer_name: form.get("customer_name"),
      customer_email: form.get("customer_email"),
      customer_phone: form.get("customer_phone"),
      notes: form.get("notes"),
    });
  } catch (e) {
    // Keep the visitor's choices on screen with a way forward, instead of
    // the error page (which used to discard the whole selection).
    const message = e instanceof Error ? e.message : "";
    const readable = message && !/^HTTP \d+/.test(message) && message.length <= 160 ? `${message}. ` : "";
    return json({ success: false, error: `${readable}${CONFIRM_FAILED}` }, { status: 409 });
  }

  // Deposit-gated shop: hand the customer to the hosted Stripe page; the
  // success URL returns them to /confirm and the webhook confirms the booking.
  if (booking.checkout_url) {
    return redirect(booking.checkout_url);
  }

  return redirect(`/${slug}/confirm?id=${booking.id}`);
}

const STEPS = ["Service", "Team member", "Date and time", "Your details", "Review"];

/** Deposit due for a service under the shop's config: percent of price with a
 *  floor, never more than the price itself (matches the worker's clamp). */
function depositDuePence(pricePence: number, cfg: { percent: number; min_pence: number }): number {
  return Math.min(pricePence, Math.max(Math.round((pricePence * cfg.percent) / 100), cfg.min_pence));
}

/** Whole-pound prices read "£24" exactly as on the shop's site cards. */
function displayPence(pence: number): string {
  return pence % 100 === 0 ? `£${pence / 100}` : formatPence(pence);
}

function displayDate(date: string): string {
  return formatDay(date, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
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
    const demo = isPortfolioDemoShop(layoutData.slug);
    return (
      <CommercialShopChrome
        site={siteDataForChrome(layoutData.shop.name, site, layoutData.shop.id)}
        settings={layoutData.settings ?? {}}
        shopSlug={layoutData.slug}
        bookingBar={false}
        // A demo's scripted assistant answers from the same menu and team.
        services={demo ? layoutData.commercialServices : undefined}
        staff={demo ? layoutData.staff : undefined}
      >
        <BookingWizard key={layoutData.slug} shopName={layoutData.shop.name} />
      </CommercialShopChrome>
    );
  }
  return (
    <div className="pp-commercial" style={platformFallbackVars}>
      <BookingWizard />
    </div>
  );
}

const choiceClass = (selected: boolean) =>
  `w-full rounded-xl border p-4 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--st-card)] ${
    selected
      ? "border-[color:var(--color-accent)] bg-[color:var(--st-accent-10)]"
      : "border-[color:var(--st-line-10)] bg-[color:var(--st-bg)] hover:border-[color:var(--st-accent-40)]"
  }`;

function BookingWizard({ shopName }: { shopName?: string }) {
  const {
    slug,
    services,
    staff,
    slots,
    shopTimezone,
    deposit,
    paymentCancelled,
    closedDay,
    today,
    preselectServiceId,
    preselectStaffId,
    preselectDay,
    preselectStep,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success: boolean; error?: string }>();
  const nav = useNavigation();
  const slotsFetcher = useFetcher<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const demo = isPortfolioDemoShop(slug);
  const [demoComplete, setDemoComplete] = useState(false);
  const initialService = services.find((s) => s.id === preselectServiceId) ?? null;
  const [step, setStep] = useState(preselectStep);
  const [selection, setSelection] = useState({
    service: initialService as Service | null,
    staffId: preselectStaffId || "",
    date: preselectDay || "",
    slot: "",
    name: demo ? "Demo Guest" : "",
    email: demo ? "guest@example.com" : "",
    phone: "",
    notes: "",
  });

  // Move focus to the new step's heading so keyboard and screen-reader users
  // land on the step they just opened (focus used to drop to <body>).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus();
  }, [step, demoComplete]);

  // Slots come from the client-side fetcher once a date is picked; fall back to
  // the loader's slots. Dedupe by start_time (for "any staff", several staff can
  // be free at the same time) and keep only available ones.
  const rawSlots = (slotsFetcher.data?.slots ?? slots) as Slot[];
  const dayClosed = Boolean(slotsFetcher.data?.closedDay ?? closedDay);
  const availableSlots = [
    ...new Map(rawSlots.filter((s) => s.is_available).map((s) => [s.start_time, s])).values(),
  ].sort((a, b) => a.start_time.localeCompare(b.start_time));

  const chooseService = (s: Service) => {
    setSelection((p) => ({ ...p, service: s, date: "", slot: "" }));
    setStep(selection.staffId ? 2 : 1);
  };

  const loadSlots = (date: string, serviceId: string, staffId: string) => {
    const staffParam = staffId && staffId !== "any" ? `&staff_id=${encodeURIComponent(staffId)}` : "";
    slotsFetcher.load(`/${slug}/book?date=${encodeURIComponent(date)}&service_id=${encodeURIComponent(serviceId)}${staffParam}`);
  };

  // A restored day needs its times again (a GET, like picking the day).
  useEffect(() => {
    if (preselectDay && initialService) loadSlots(preselectDay, initialService.id, preselectStaffId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for the day the URL restored
  }, []);

  // Keep the wizard's place in the URL (replace, so Back still leaves the
  // page). Only choices are recorded: no time and no personal details.
  const serviceIdChosen = selection.service?.id ?? "";
  useEffect(() => {
    if (demoComplete) return;
    const next = wizardSearch(searchParams, {
      step,
      serviceId: serviceIdChosen,
      staffId: selection.staffId,
      day: selection.date,
    });
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true, preventScrollReset: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchParams is read, not watched
  }, [step, serviceIdChosen, selection.staffId, selection.date, demoComplete]);

  if (demoComplete) return (
    <section className="mx-auto max-w-2xl px-4 py-16" aria-live="polite">
      <h1 ref={headingRef} tabIndex={-1} className="pp-heading text-3xl font-semibold focus:outline-none">Demo complete</h1>
      <p className="mt-4">No appointment was booked. No payment was taken and no email was sent.</p>
      <p className="mt-2">This walkthrough used the shop&apos;s menu with sample times and guest details.</p>
      <ThemedButton className="mt-6 min-h-11" onClick={() => { setDemoComplete(false); setStep(0); setSelection(p => ({ ...p, service: null, staffId: "", date: "", slot: "" })); }}>Try again</ThemedButton>
    </section>
  );

  const staffName = selection.staffId === "any" || !selection.staffId
    ? "Any available"
    : staff.find((s) => s.id === selection.staffId)?.display_name ?? "Any available";

  return (
    <div className="min-h-screen bg-[color:var(--st-bg)] px-4 pb-28 pt-10 text-[color:var(--st-ink)] sm:px-6 md:pb-12">
      <div className="mx-auto max-w-2xl">
        <h1 className="pp-heading text-[clamp(1.6rem,4vw,2.25rem)] font-bold leading-tight text-[color:var(--st-ink)] [text-wrap:balance]">
          {demo ? "Try a demo booking" : shopName ? `Book at ${shopName}` : "Book an appointment"}
        </h1>
        {demo ? (
          <p className="mt-2 text-sm text-[color:var(--st-ink-60)]">
            Simulated: the menu and team are the demo shop&apos;s own, the times are samples, and nothing is reserved, charged or emailed.
          </p>
        ) : null}
        {paymentCancelled && (
          <div
            className="mt-6 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
            style={lightDark("#92400e", "#fde68a")}
            role="status"
          >
            Payment cancelled. Your slot has been released, so pick a time below to book again.
          </div>
        )}
        {/* Progress */}
        <div className="mb-8 mt-6">
          <div className="mb-2 flex items-center justify-between" aria-live="polite">
            <p className="text-sm text-[color:var(--st-ink-60)]">Step {step + 1} of {STEPS.length}</p>
            <p className="text-sm font-medium text-[color:var(--st-ink)]">{STEPS[step]}</p>
          </div>
          <div className="h-1 w-full rounded-full bg-[color:var(--st-chip)]" aria-hidden>
            <div
              className="h-1 rounded-full bg-[color:var(--color-accent)] transition-all"
              style={{ width: `${((step + 1) / STEPS.length) * 100}%` }}
            />
          </div>
        </div>

        <div className="rounded-2xl border border-[color:var(--st-line-10)] bg-[color:var(--st-card)] p-5 sm:p-8">
          {step === 0 && (
            <div className="space-y-3">
              <h2 ref={headingRef} tabIndex={-1} className="pp-heading text-2xl font-bold text-[color:var(--st-ink)] focus:outline-none">Choose a service</h2>
              {services.length === 0 ? (
                <p className="text-[color:var(--st-ink-60)]">No services are bookable online yet.</p>
              ) : (
                services.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={selection.service?.id === s.id}
                    onClick={() => chooseService(s)}
                    className={choiceClass(selection.service?.id === s.id)}
                  >
                    <span className="flex items-baseline justify-between gap-4">
                      <span className="font-medium text-[color:var(--st-ink)]">{s.name}</span>
                      <span className="shrink-0 font-semibold tabular-nums text-[color:var(--st-accent-text)]">{displayPence(s.price_pence)}</span>
                    </span>
                    <span className="mt-0.5 block text-sm text-[color:var(--st-ink-60)]">{s.durationMinutes} min</span>
                    {s.description ? <span className="mt-2 block text-sm text-[color:var(--st-ink-70)]">{s.description}</span> : null}
                  </button>
                ))
              )}
            </div>
          )}

          {step === 1 && (
            <div className="space-y-3">
              <h2 ref={headingRef} tabIndex={-1} className="pp-heading text-2xl font-bold text-[color:var(--st-ink)] focus:outline-none">Choose who you&apos;d like</h2>
              {selection.service ? (
                <p className="text-sm text-[color:var(--st-ink-60)]">
                  {selection.service.name}, {selection.service.durationMinutes} min, {displayPence(selection.service.price_pence)}
                </p>
              ) : null}
              <button
                type="button"
                aria-pressed={selection.staffId === "any"}
                onClick={() => { setSelection((p) => ({ ...p, staffId: "any", date: "", slot: "" })); setStep(2); }}
                className={choiceClass(selection.staffId === "any")}
              >
                <span className="block font-medium text-[color:var(--st-ink)]">Any available</span>
                <span className="block text-sm text-[color:var(--st-ink-60)]">See every free time across the team</span>
              </button>
              {staff.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={selection.staffId === s.id}
                  onClick={() => { setSelection((p) => ({ ...p, staffId: s.id, date: "", slot: "" })); setStep(2); }}
                  className={`flex items-center gap-4 ${choiceClass(selection.staffId === s.id)}`}
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[color:var(--st-accent-20)] pp-heading font-bold text-[color:var(--st-accent-text)]">
                    {s.avatar_url ? <img src={s.avatar_url} alt="" className="h-full w-full object-cover" /> : s.display_name.charAt(0)}
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium text-[color:var(--st-ink)]">{s.display_name}</span>
                    {s.speciality ? (
                      <span className="block text-sm text-[color:var(--st-ink-60)]">{s.speciality}</span>
                    ) : s.bio ? (
                      <span className="block text-sm text-[color:var(--st-ink-60)] line-clamp-2">{s.bio}</span>
                    ) : null}
                  </span>
                </button>
              ))}
              <div className="pt-2">
                <ThemedButton variant="ghost" className="min-h-11" onClick={() => setStep(0)}>Back</ThemedButton>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <h2 ref={headingRef} tabIndex={-1} className="pp-heading text-2xl font-bold text-[color:var(--st-ink)] focus:outline-none">Pick a date and time</h2>
              <p className="text-sm text-[color:var(--st-ink-60)]">
                {selection.service?.name} with {staffName}
                {demo ? ". Sample times." : "."}
              </p>
              <ThemedInput
                label="Date"
                type="date"
                value={selection.date}
                min={today}
                onChange={(e) => {
                  const date = e.target.value;
                  setSelection((p) => ({ ...p, date, slot: "" }));
                  if (date && selection.service) loadSlots(date, selection.service.id, selection.staffId);
                }}
              />

              <div aria-live="polite">
                {slotsFetcher.state === "loading" && (
                  <p className="text-sm text-[color:var(--st-ink-60)]">Loading available times…</p>
                )}

                {slotsFetcher.state !== "loading" && availableSlots.length > 0 && (
                  <fieldset>
                    <legend className="mb-2 text-sm font-medium text-[color:var(--st-ink-80)]">Available times</legend>
                    <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                      {availableSlots.map((slot) => (
                        <button
                          key={slot.start_time}
                          type="button"
                          aria-pressed={selection.slot === slot.start_time}
                          onClick={() => setSelection((p) => ({ ...p, slot: slot.start_time }))}
                          className={`min-h-11 rounded-lg border text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-accent)] ${
                            selection.slot === slot.start_time ? "border-[color:var(--color-accent)] bg-[color:var(--st-accent-20)] text-[color:var(--st-accent-text)]" : "border-[color:var(--st-line-40)] text-[color:var(--st-ink-70)] hover:border-[color:var(--st-accent-40)]"
                          }`}
                        >
                          {formatSlotTime(slot.start_time, shopTimezone)}
                        </button>
                      ))}
                    </div>
                  </fieldset>
                )}

                {selection.date && slotsFetcher.state !== "loading" && availableSlots.length === 0 && (
                  <p className="text-sm text-[color:var(--st-ink-70)]">
                    {dayClosed
                      ? `The shop is closed on ${weekdayName(selection.date)}s. Choose another date.`
                      : "No times left on this date. Choose another date."}
                  </p>
                )}
              </div>

              <div className="flex gap-3">
                <ThemedButton variant="ghost" className="min-h-11" onClick={() => setStep(1)}>Back</ThemedButton>
                <ThemedButton className="min-h-11" disabled={!selection.slot} onClick={() => setStep(3)}>Next</ThemedButton>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4">
              <h2 ref={headingRef} tabIndex={-1} className="pp-heading text-2xl font-bold text-[color:var(--st-ink)] focus:outline-none">Your details</h2>
              {selection.service && selection.date && selection.slot ? (
                <p className="text-sm text-[color:var(--st-ink-60)]">
                  {selection.service.name} with {staffName}, {displayDate(selection.date)} at{" "}
                  {formatSlotTime(selection.slot, shopTimezone)}.
                </p>
              ) : null}
              {demo ? (
                <div className="space-y-3">
                  <p>Sample guest details are supplied for this demo. Please do not enter personal information.</p>
                  <Row label="Name" value={selection.name} />
                  <Row label="Email" value={selection.email} />
                </div>
              ) : <>
              <ThemedInput label="Full name" name="name" autoComplete="name" value={selection.name} onChange={(e) => setSelection((p) => ({ ...p, name: e.target.value }))} required />
              <ThemedInput label="Email address" name="email" type="email" autoComplete="email" value={selection.email} onChange={(e) => setSelection((p) => ({ ...p, email: e.target.value }))} required />
              <ThemedInput label="Phone (optional)" name="tel" type="tel" autoComplete="tel" value={selection.phone} onChange={(e) => setSelection((p) => ({ ...p, phone: e.target.value }))} />
              <ThemedTextarea
                label="Notes (optional)"
                rows={3}
                value={selection.notes}
                onChange={(e) => setSelection((p) => ({ ...p, notes: e.target.value }))}
              />
              </>}
              <div className="flex gap-3">
                <ThemedButton variant="ghost" className="min-h-11" onClick={() => setStep(2)}>Back</ThemedButton>
                <ThemedButton className="min-h-11" disabled={!selection.name || !selection.email} onClick={() => setStep(4)}>Next</ThemedButton>
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

              <h2 ref={headingRef} tabIndex={-1} className="pp-heading text-2xl font-bold text-[color:var(--st-ink)] focus:outline-none">Review and confirm</h2>
              {actionData?.error ? (
                <div role="alert" className="rounded-lg border border-[color:var(--st-line-40)] bg-[color:var(--st-bg)] p-4 text-sm">
                  <p className="text-[color:var(--st-ink)]">{actionData.error}</p>
                  <ThemedButton type="button" variant="ghost" className="mt-3 min-h-11" onClick={() => { setSelection((p) => ({ ...p, slot: "" })); setStep(2); }}>
                    Choose another time
                  </ThemedButton>
                </div>
              ) : null}
              <div className="space-y-3 rounded-xl border border-[color:var(--st-line-10)] bg-[color:var(--st-bg)] p-4 text-sm">
                <Row label="Service" value={selection.service?.name ?? "Not selected"} />
                <Row label="With" value={staffName} />
                <Row label="Price" value={displayPence(selection.service?.price_pence ?? 0)} />
                {deposit && selection.service && (
                  <Row
                    label="Deposit due now"
                    value={displayPence(depositDuePence(selection.service.price_pence, deposit))}
                  />
                )}
                <Row label="Date" value={selection.date ? displayDate(selection.date) : "Not selected"} />
                <Row label="Time" value={selection.slot ? formatSlotTime(selection.slot, shopTimezone) : "Not selected"} />
                <Row label="Name" value={selection.name} />
                <Row label="Email" value={selection.email} />
              </div>
              {deposit && selection.service && (
                <p className="text-xs text-[color:var(--st-ink-60)]">
                  You&apos;ll be taken to a secure Stripe page to pay the deposit. The remaining balance is
                  settled at your appointment.
                </p>
              )}
              <div className="flex gap-3">
                <ThemedButton type="button" variant="ghost" className="min-h-11" onClick={() => setStep(3)}>Back</ThemedButton>
                <ThemedButton type="submit" disabled={nav.state === "submitting"} className="min-h-11 flex-1">
                  {nav.state === "submitting"
                    ? "Confirming…"
                    : deposit
                      ? "Continue to payment"
                      : demo ? "Complete demo booking" : "Confirm booking"}
                </ThemedButton>
              </div>
              <p className="text-center text-xs text-[color:var(--st-ink-60)]">
                {demo ? "These are sample details. Nothing is reserved or sent. See our " : "We use these details only to manage your booking. See our "}
                <a
                  href={`/${slug}/privacy`}
                  className="underline underline-offset-4 hover:text-[color:var(--st-ink-80)]"
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
  return formatTime(iso, { hour: "2-digit", minute: "2-digit", timeZone: tz });
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="text-[color:var(--st-ink-60)]">{label}</span>
      <span className="text-right font-medium text-[color:var(--st-ink)]">{value}</span>
    </div>
  );
}
