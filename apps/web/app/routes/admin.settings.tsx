import { useEffect, useId, useRef, useState } from "react";
import { useFetcher, useLoaderData, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { readJsonObject } from "@repo/utils";
import { clsx } from "clsx";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { ErrorScreen } from "~/components/ErrorScreen";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";
import { pageShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { parsePoundsToPence } from "@repo/utils";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Settings");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
type DayKey = (typeof DAY_KEYS)[number];

const DAY_LABELS: Record<DayKey, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

function buildTimeOptions(): string[] {
  const out: string[] = [];
  for (let h = 6; h <= 23; h++) {
    for (const m of [0, 30]) {
      if (h === 23 && m === 30) break;
      out.push(`${String(h).padStart(2, "0")}:${m === 0 ? "00" : "30"}`);
    }
  }
  return out;
}

const TIME_OPTIONS = buildTimeOptions();

/** The half-hour choices, plus the saved time when it is not one of them
 *  (so a stored "09:15" shows as itself, not as the first option). */
function timeOptionsWith(value: string): string[] {
  return TIME_OPTIONS.includes(value) ? TIME_OPTIONS : [...TIME_OPTIONS, value].sort();
}

type DayState = { open: boolean; start: string; end: string };

function defaultDayState(): DayState {
  return { open: false, start: "09:00", end: "17:00" };
}

function parseHoursJson(json: string | undefined | null): Record<DayKey, DayState> {
  const base = Object.fromEntries(DAY_KEYS.map((k) => [k, defaultDayState()])) as Record<DayKey, DayState>;
  if (!json?.trim()) return base;
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    for (const k of DAY_KEYS) {
      const v = o[k];
      const s = v == null ? "" : String(v).trim();
      if (!s || s.toLowerCase() === "closed") {
        base[k] = defaultDayState();
      } else {
        const parts = s.split(/\s*[-–]\s*/);
        const start = (parts[0] || "09:00").trim();
        const end = (parts[1] || "17:00").trim();
        base[k] = { open: true, start, end };
      }
    }
  } catch {
    /* keep defaults */
  }
  return base;
}

function serializeHoursJson(state: Record<DayKey, DayState>): string {
  const o: Record<string, string> = {};
  for (const k of DAY_KEYS) {
    const d = state[k];
    o[k] = d.open && d.start && d.end ? `${d.start}-${d.end}` : "";
  }
  return JSON.stringify(o);
}

type ShopSettingsPayload = {
  phone?: string;
  address?: string;
  lat?: number | null;
  lng?: number | null;
  hours_json?: string;
  instagram_url?: string;
  facebook_url?: string;
  tiktok_url?: string;
  twitter_url?: string;
  youtube_url?: string;
  whatsapp_url?: string;
  linkedin_url?: string;
  show_instagram?: boolean;
  show_facebook?: boolean;
  show_tiktok?: boolean;
  show_twitter?: boolean;
  show_youtube?: boolean;
  show_whatsapp?: boolean;
  show_linkedin?: boolean;
  google_business_url?: string;
  show_google_business?: boolean;
  booking_confirmation_email?: boolean;
  booking_reminder_email?: boolean;
  reminder_hours_before?: number;
  review_request_email?: boolean;
  deposits_enabled?: boolean;
  deposit_percent?: number;
  deposit_min_pence?: number;
};

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const shopId = pageShopId(request, user);
  if (!shopId || !token) {
    return json({
      shopId: null as string | null,
      settings: {} as ShopSettingsPayload,
      error: "no_shop" as const,
      loadError: false,
    });
  }
  const api = createApiClient(env.API_URL, token);
  let settings: ShopSettingsPayload = {};
  // A failed load must not become a blank form: saving one would write empty
  // opening hours and contact details over the real ones. The page shows the
  // failure and no form at all.
  let loadError = false;
  try {
    settings = (await api.get(`/api/shops/${shopId}/settings`)) as ShopSettingsPayload;
  } catch {
    loadError = true;
  }
  return json({ shopId, settings, error: null as null, loadError });
}

type ActionData = { ok: boolean; message?: string; error?: string; ts: number };

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ ok: false, error: "Unauthorized", ts: Date.now() }, 401);
  const user = await requireRole(request, "admin", env.API_URL);
  const shopId = pageShopId(request, user);
  if (!shopId) {
    return json<ActionData>({ ok: false, error: "No shop assigned", ts: Date.now() }, 400);
  }
  const body = await readJsonObject(request);
  if (!body) {
    return json<ActionData>({ ok: false, error: "Invalid JSON", ts: Date.now() }, 400);
  }
  const api = createApiClient(env.API_URL, token);
  try {
    await api.patch(`/api/shops/${shopId}/settings`, body);
    return json<ActionData>({ ok: true, message: "Saved successfully.", ts: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Save failed";
    return json<ActionData>({ ok: false, error: msg, ts: Date.now() }, 400);
  }
}

type Patch = Record<string, string | number | boolean | null>;
type Toast = { type: "success" | "error"; text: string };
type Notify = (toast: Toast) => void;

/** One section's Save: its own fetcher, so only its button reads "Saving…". */
function useSectionSave(what: string, notify: Notify, onSaved?: () => void) {
  const fetcher = useFetcher<ActionData>();
  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      onSaved?.();
      notify({ type: "success", text: `${what} saved.` });
    } else {
      notify({ type: "error", text: `${what} not saved: ${data.error ?? "the save failed"}. Try again.` });
    }
  });
  return {
    busy: fetcher.state !== "idle",
    save: (patch: Patch) => fetcher.submit(patch, { method: "POST", encType: "application/json" }),
  };
}

/**
 * A setting that saves the moment it changes (the email switches and the
 * reminder timing). The control shows the new value at once, and goes back
 * to the last saved one if the save fails.
 */
function useInstantSetting<T extends string | number | boolean>(key: string, initial: T, what: string, notify: Notify) {
  const fetcher = useFetcher<ActionData>();
  const [value, setValue] = useState<T>(initial);
  const saved = useRef<T>(initial);
  const attempted = useRef<T>(initial);
  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      saved.current = attempted.current;
      notify({ type: "success", text: `${what} saved.` });
    } else {
      setValue(saved.current);
      notify({
        type: "error",
        text: `${what} not saved, so it has been put back: ${data.error ?? "the save failed"}. Try again.`,
      });
    }
  });
  return {
    value,
    busy: fetcher.state !== "idle",
    change: (next: T) => {
      attempted.current = next;
      setValue(next);
      fetcher.submit({ [key]: next }, { method: "POST", encType: "application/json" });
    },
  };
}

export default function AdminSettings() {
  const { shopId, settings, error, loadError } = useLoaderData<typeof loader>();

  if (error === "no_shop" || !shopId) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Shop settings</h1>
        <p className="text-sm text-white/60">
          No shop is linked to your account. Contact support if you need help.
        </p>
      </div>
    );
  }

  if (loadError) {
    // No form: a blank one could be saved over the real settings.
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <h1 className="font-heading text-2xl font-bold text-white">Shop settings</h1>
        <LoadError what="your shop settings" />
      </div>
    );
  }

  // Mounted only with loaded settings, so every field starts from a real value.
  return <SettingsForms settings={settings} />;
}

function SettingsForms({ settings }: { settings: ShopSettingsPayload }) {
  const [toast, setToast] = useState<Toast | null>(null);

  // A success message clears itself. An error stays until dismissed or replaced.
  useEffect(() => {
    if (!toast || toast.type === "error") return;
    const t = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(t);
  }, [toast]);

  const [phone, setPhone] = useState(settings.phone ?? "");
  const [address, setAddress] = useState(settings.address ?? "");
  const [lat, setLat] = useState(settings.lat != null ? String(settings.lat) : "");
  const [lng, setLng] = useState(settings.lng != null ? String(settings.lng) : "");
  const [coordErrors, setCoordErrors] = useState<{ lat?: string; lng?: string }>({});

  const [hoursState, setHoursState] = useState(() => parseHoursJson(settings.hours_json));
  const [hoursError, setHoursError] = useState<string | null>(null);

  const [ig, setIg] = useState(settings.instagram_url ?? "");
  const [fb, setFb] = useState(settings.facebook_url ?? "");
  const [tt, setTt] = useState(settings.tiktok_url ?? "");
  const [tw, setTw] = useState(settings.twitter_url ?? "");
  const [yt, setYt] = useState(settings.youtube_url ?? "");
  const [wa, setWa] = useState(settings.whatsapp_url ?? "");
  const [li, setLi] = useState(settings.linkedin_url ?? "");

  const [showIg, setShowIg] = useState(settings.show_instagram === true);
  const [showFb, setShowFb] = useState(settings.show_facebook === true);
  const [showTt, setShowTt] = useState(settings.show_tiktok === true);
  const [showTw, setShowTw] = useState(settings.show_twitter === true);
  const [showYt, setShowYt] = useState(settings.show_youtube === true);
  const [showWa, setShowWa] = useState(settings.show_whatsapp === true);
  const [showLi, setShowLi] = useState(settings.show_linkedin === true);

  // Email settings save the moment they change, and go back if the save fails.
  const confirmEmail = useInstantSetting("booking_confirmation_email", settings.booking_confirmation_email !== false, "Booking confirmation email", setToast);
  const reminderEmail = useInstantSetting("booking_reminder_email", settings.booking_reminder_email !== false, "Booking reminder email", setToast);
  const reminderHours = useInstantSetting("reminder_hours_before", settings.reminder_hours_before ?? 24, "Reminder timing", setToast);
  const reviewEmail = useInstantSetting("review_request_email", settings.review_request_email !== false, "Review request email", setToast);

  // Deposits are money, so the whole section saves together with one button:
  // the switch, the percentage and the minimum. What is saved is kept here so
  // the section can say when it has unsaved changes.
  const [savedDeposits, setSavedDeposits] = useState(() => ({
    enabled: settings.deposits_enabled === true,
    percent: settings.deposit_percent ?? 50,
    min: settings.deposit_min_pence != null ? (settings.deposit_min_pence / 100).toFixed(2) : "5.00",
  }));
  const [depositsEnabled, setDepositsEnabled] = useState(savedDeposits.enabled);
  const [depositPercent, setDepositPercent] = useState(savedDeposits.percent);
  const [depositMin, setDepositMin] = useState(savedDeposits.min);
  const [depositMinError, setDepositMinError] = useState<string | null>(null);
  const depositsAttempt = useRef(savedDeposits);
  const depositsDirty =
    depositsEnabled !== savedDeposits.enabled ||
    (depositsEnabled && (depositPercent !== savedDeposits.percent || depositMin.trim() !== savedDeposits.min));

  const contact = useSectionSave("Contact details", setToast);
  const hours = useSectionSave("Opening hours", setToast);
  const social = useSectionSave("Social media links", setToast);
  const deposits = useSectionSave("Deposit settings", setToast, () => setSavedDeposits(depositsAttempt.current));

  const saveContact = () => {
    const errors: { lat?: string; lng?: string } = {};
    const latN = lat.trim() === "" ? null : Number(lat);
    const lngN = lng.trim() === "" ? null : Number(lng);
    if (latN !== null && (!Number.isFinite(latN) || latN < -90 || latN > 90)) {
      errors.lat = "Enter a latitude between -90 and 90, or leave it empty.";
    }
    if (lngN !== null && (!Number.isFinite(lngN) || lngN < -180 || lngN > 180)) {
      errors.lng = "Enter a longitude between -180 and 180, or leave it empty.";
    }
    setCoordErrors(errors);
    if (errors.lat || errors.lng) return;
    contact.save({ phone: phone.trim(), address: address.trim(), lat: latN, lng: lngN });
  };

  const saveHours = () => {
    const backwards = DAY_KEYS.find((k) => hoursState[k].open && hoursState[k].end <= hoursState[k].start);
    if (backwards) {
      setHoursError(`${DAY_LABELS[backwards]} must close after it opens. Nothing has been saved.`);
      return;
    }
    setHoursError(null);
    hours.save({ hours_json: serializeHoursJson(hoursState) });
  };

  const saveDeposits = () => {
    if (!depositsEnabled) {
      // The percentage and minimum are hidden while deposits are off, so only the switch is sent.
      setDepositMinError(null);
      depositsAttempt.current = { ...savedDeposits, enabled: false };
      deposits.save({ deposits_enabled: false });
      return;
    }
    // Form-input boundary (WS-4): pounds text -> integer pence. An amount
    // that cannot be read is an error on the field, never a silent default.
    const minPence = parsePoundsToPence(depositMin);
    if (minPence === null) {
      setDepositMinError("Enter the minimum deposit in pounds, for example 5 or 5.00. Nothing has been saved.");
      return;
    }
    setDepositMinError(null);
    depositsAttempt.current = { enabled: true, percent: depositPercent, min: depositMin.trim() };
    deposits.save({
      deposits_enabled: true,
      deposit_percent: depositPercent,
      deposit_min_pence: minPence,
    });
  };

  const saveSocial = () => {
    social.save({
      instagram_url: ig.trim(),
      facebook_url: fb.trim(),
      tiktok_url: tt.trim(),
      twitter_url: tw.trim(),
      youtube_url: yt.trim(),
      whatsapp_url: wa.trim(),
      linkedin_url: li.trim(),
      show_instagram: showIg,
      show_facebook: showFb,
      show_tiktok: showTt,
      show_twitter: showTw,
      show_youtube: showYt,
      show_whatsapp: showWa,
      show_linkedin: showLi,
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-10 pb-12">
      {toast ? (
        <div
          className={clsx(
            "fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] right-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border px-4 py-3 text-sm md:bottom-6 md:right-6",
            toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-950 text-emerald-100"
              : "border-red-500/40 bg-red-950 text-red-100"
          )}
          // A failure interrupts; a success is announced politely.
          role={toast.type === "error" ? "alert" : "status"}
        >
          <span className="flex-1">{toast.text}</span>
          {toast.type === "error" && (
            <button
              type="button"
              onClick={() => setToast(null)}
              className="tap-target -my-2 -mr-2 rounded-lg px-2 text-sm font-medium text-red-100 underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
            >
              Dismiss
            </button>
          )}
        </div>
      ) : null}

      <h1 className="font-heading text-2xl font-bold text-white">Shop settings</h1>

      {/* Contact */}
      <section className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Contact and location</h2>
        <div className="space-y-4">
          <Input label="Phone number" name="phone" type="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input label="Address" name="address" autoComplete="street-address" value={address} onChange={(e) => setAddress(e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Latitude (optional)" name="lat" inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="e.g. 51.5074" error={coordErrors.lat} />
            <Input label="Longitude (optional)" name="lng" inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="e.g. -0.1278" error={coordErrors.lng} />
          </div>
          <p className="text-xs text-white/60">
            The address is shown on your site. Latitude and longitude place the pin on your map; leave them empty if you are not sure.
          </p>
        </div>
        <Button type="button" size="sm" onClick={saveContact} disabled={contact.busy}>
          {contact.busy ? "Saving…" : "Save contact details"}
        </Button>
      </section>

      {/* Hours */}
      <section className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Opening hours</h2>
        <div className="space-y-3">
          {DAY_KEYS.map((k) => {
            const row = hoursState[k];
            const day = DAY_LABELS[k];
            return (
              <div
                key={k}
                className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="w-28 shrink-0 text-sm font-medium text-white/90" aria-hidden>{day}</div>
                <label className="tap-target flex cursor-pointer items-center gap-2 text-sm text-white/80">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded accent-gold"
                    checked={row.open}
                    onChange={(e) =>
                      setHoursState((prev) => ({
                        ...prev,
                        [k]: { ...prev[k], open: e.target.checked },
                      }))
                    }
                  />
                  <span><span className="sr-only">{day}: </span>Open</span>
                </label>
                <div className="flex flex-1 items-center gap-2 sm:justify-end">
                  <div className="min-w-0 flex-1 sm:max-w-[9rem]">
                    <Select
                      label={`${day} opens at`}
                      hideLabel
                      disabled={!row.open}
                      value={row.start}
                      onChange={(e) =>
                        setHoursState((prev) => ({
                          ...prev,
                          [k]: { ...prev[k], start: e.target.value },
                        }))
                      }
                    >
                      {timeOptionsWith(row.start).map((t) => (
                        <option key={t} className="bg-dark text-white" value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </div>
                  <span className="text-sm text-white/60" aria-hidden>to</span>
                  <div className="min-w-0 flex-1 sm:max-w-[9rem]">
                    <Select
                      label={`${day} closes at`}
                      hideLabel
                      disabled={!row.open}
                      value={row.end}
                      onChange={(e) =>
                        setHoursState((prev) => ({
                          ...prev,
                          [k]: { ...prev[k], end: e.target.value },
                        }))
                      }
                    >
                      {timeOptionsWith(row.end).map((t) => (
                        <option key={t} className="bg-dark text-white" value={t}>
                          {t}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {hoursError && <p role="alert" className="text-sm text-red-400">{hoursError}</p>}
        <Button type="button" size="sm" onClick={saveHours} disabled={hours.busy}>
          {hours.busy ? "Saving…" : "Save opening hours"}
        </Button>
      </section>

      {/* Social */}
      <section className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Social media</h2>
        <div className="space-y-5">
          <SocialRow label="Instagram" url={ig} onUrlChange={setIg} show={showIg} onShowChange={setShowIg} />
          <SocialRow label="Facebook" url={fb} onUrlChange={setFb} show={showFb} onShowChange={setShowFb} />
          <SocialRow label="TikTok" url={tt} onUrlChange={setTt} show={showTt} onShowChange={setShowTt} />
          <SocialRow label="Twitter / X" url={tw} onUrlChange={setTw} show={showTw} onShowChange={setShowTw} />
          <SocialRow label="YouTube" url={yt} onUrlChange={setYt} show={showYt} onShowChange={setShowYt} />
          <SocialRow label="WhatsApp" url={wa} onUrlChange={setWa} show={showWa} onShowChange={setShowWa} />
          <SocialRow label="LinkedIn" url={li} onUrlChange={setLi} show={showLi} onShowChange={setShowLi} />
        </div>
        <Button type="button" size="sm" onClick={saveSocial} disabled={social.busy}>
          {social.busy ? "Saving…" : "Save social media links"}
        </Button>
      </section>

      {/* Notification preferences */}
      <section className="space-y-5 rounded-xl border border-white/10 bg-dark-100 p-6">
        <div>
          <h2 className="font-heading text-lg font-semibold text-white">Email notifications</h2>
          <p className="mt-1 text-sm text-white/60">
            Choose which automatic emails your customers get. Each change here is saved straight away.
          </p>
        </div>

        <ToggleRow
          label="Booking confirmation"
          hint="Sent immediately when a booking is made"
          value={confirmEmail.value}
          busy={confirmEmail.busy}
          onChange={confirmEmail.change}
        />

        <div className="space-y-3 border-t border-white/10 pt-4">
          <ToggleRow
            label="Booking reminder"
            hint="Sent before the appointment"
            value={reminderEmail.value}
            busy={reminderEmail.busy}
            onChange={reminderEmail.change}
          />
          {reminderEmail.value && (
            <div className="max-w-xs">
              <Select
                label="Send the reminder"
                value={reminderHours.value}
                disabled={reminderHours.busy}
                onChange={(e) => reminderHours.change(Number(e.target.value))}
              >
                {[2, 4, 6, 12, 24, 48, 72].map((h) => (
                  <option key={h} value={h} className="bg-dark">{h} hours before the appointment</option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div className="border-t border-white/10 pt-4">
          <ToggleRow
            label="Review request"
            hint="Sent when a booking is marked completed"
            value={reviewEmail.value}
            busy={reviewEmail.busy}
            onChange={reviewEmail.change}
          />
        </div>
      </section>

      {/* Booking deposits */}
      <section className="space-y-5 rounded-xl border border-white/10 bg-dark-100 p-6">
        <div>
          <h2 className="font-heading text-lg font-semibold text-white">Booking deposits</h2>
          <p className="mt-1 text-sm text-white/60">
            Take a card deposit when customers book online. Requires Stripe payments to be set up
            (Settings → Payments). The remaining balance is settled at the appointment.
          </p>
          <p className="mt-1 text-sm text-white/60">
            Nothing in this section changes until you press Save deposit settings.
          </p>
        </div>

        <ToggleRow
          label="Require a deposit at online booking"
          hint="The slot is only confirmed once the deposit is paid; abandoned payments free the slot after 30 minutes"
          value={depositsEnabled}
          busy={deposits.busy}
          onChange={setDepositsEnabled}
        />

        {depositsEnabled && (
          <div className="space-y-4 border-t border-white/10 pt-4">
            <div className="max-w-xs">
              <Select
                label="Deposit, as a share of the service price"
                value={depositPercent}
                onChange={(e) => setDepositPercent(Number(e.target.value))}
              >
                {[10, 20, 25, 30, 40, 50, 75, 100].map((p) => (
                  <option key={p} value={p} className="bg-dark">{p}%</option>
                ))}
              </Select>
            </div>
            <div className="max-w-xs">
              <Input
                label="Minimum deposit (£)"
                inputMode="decimal"
                value={depositMin}
                onChange={(e) => {
                  setDepositMin(e.target.value);
                  setDepositMinError(null);
                }}
                placeholder="5.00"
                error={depositMinError ?? undefined}
              />
              <p className="mt-1 text-xs text-white/60">
                Never more than the service price. A high minimum becomes full prepayment.
              </p>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" onClick={saveDeposits} disabled={deposits.busy}>
            {deposits.busy ? "Saving…" : "Save deposit settings"}
          </Button>
          {depositsDirty && !deposits.busy && (
            <p role="status" className="text-sm text-amber-200">You have unsaved changes to deposits.</p>
          )}
        </div>
      </section>

    </div>
  );
}

/** A labelled on/off switch. The whole control is at least 44px tall, and its
 *  name and description are the visible text beside it. */
function ToggleRow({
  label,
  hint,
  value,
  busy = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  busy?: boolean;
  onChange: (v: boolean) => void;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <p id={labelId} className="text-sm font-medium text-white">{label}</p>
        {hint && <p id={hintId} className="mt-0.5 text-xs text-white/60">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        disabled={busy}
        onClick={() => onChange(!value)}
        className="group inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold disabled:cursor-wait disabled:opacity-60"
      >
        <span
          aria-hidden
          className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${value ? "border-gold bg-gold" : "border-white/40 bg-white/20"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${value ? "translate-x-6" : "translate-x-1"}`} />
        </span>
      </button>
    </div>
  );
}

function SocialRow({
  label,
  url,
  onUrlChange,
  show,
  onShowChange,
  placeholder = "https://…",
}: {
  label: string;
  url: string;
  onUrlChange: (v: string) => void;
  show: boolean;
  onShowChange: (v: boolean) => void;
  placeholder?: string;
}) {
  const hasUrl = url.trim().length > 0;
  return (
    <div className="space-y-2">
      <Input label={label} type="url" inputMode="url" value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder={placeholder} />
      {hasUrl ? (
        <div className="max-w-[14rem]">
          <Select
            label={`${label} link on your site`}
            value={show ? "show" : "hide"}
            onChange={(e) => onShowChange(e.target.value === "show")}
          >
            <option className="bg-dark text-white" value="show">Shown</option>
            <option className="bg-dark text-white" value="hide">Hidden</option>
          </Select>
        </div>
      ) : null}
    </div>
  );
}
