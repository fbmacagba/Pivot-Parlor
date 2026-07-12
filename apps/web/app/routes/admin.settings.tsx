import { useEffect, useRef, useState } from "react";
import {
  useFetcher,
  useLoaderData,
} from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { clsx } from "clsx";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { createApiClient } from "~/lib/api";
import { getSessionToken, requireRole } from "~/lib/auth";
import { parsePoundsToPence } from "@repo/utils";

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

const HOURS_SELECT_CLASS = clsx(
  "flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white",
  "focus:outline-none focus:ring-2 focus:ring-gold focus:border-gold",
  "disabled:cursor-not-allowed disabled:opacity-40"
);

const TOGGLE_SELECT_CLASS = clsx(HOURS_SELECT_CLASS, "max-w-[10rem]");

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
  if (!user.shop_id || !token) {
    return json({ shopId: null as string | null, settings: {} as ShopSettingsPayload, error: "no_shop" as const });
  }
  const api = createApiClient(env.API_URL, token);
  let settings: ShopSettingsPayload = {};
  try {
    settings = (await api.get(`/api/shops/${user.shop_id}/settings`)) as ShopSettingsPayload;
  } catch {
    settings = {};
  }
  return json({ shopId: user.shop_id, settings, error: null as null });
}

type ActionData = { ok: boolean; message?: string; error?: string; ts: number };

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ ok: false, error: "Unauthorized", ts: Date.now() }, 401);
  const user = await requireRole(request, "admin", env.API_URL);
  if (!user.shop_id) {
    return json<ActionData>({ ok: false, error: "No shop assigned", ts: Date.now() }, 400);
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json<ActionData>({ ok: false, error: "Invalid JSON", ts: Date.now() }, 400);
  }
  const api = createApiClient(env.API_URL, token);
  try {
    await api.patch(`/api/shops/${user.shop_id}/settings`, body);
    return json<ActionData>({ ok: true, message: "Saved successfully.", ts: Date.now() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Save failed";
    return json<ActionData>({ ok: false, error: msg, ts: Date.now() }, 400);
  }
}

export default function AdminSettings() {
  const { shopId, settings, error } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const lastHandledTs = useRef(0);

  const [toast, setToast] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    const { ts, ok, message, error: err } = fetcher.data;
    if (ts <= lastHandledTs.current) return;
    lastHandledTs.current = ts;
    if (ok) setToast({ type: "success", text: message ?? "Saved." });
    else setToast({ type: "error", text: err ?? "Save failed." });
  }, [fetcher.state, fetcher.data]);

  const [phone, setPhone] = useState(settings.phone ?? "");
  const [address, setAddress] = useState(settings.address ?? "");
  const [lat, setLat] = useState(settings.lat != null ? String(settings.lat) : "");
  const [lng, setLng] = useState(settings.lng != null ? String(settings.lng) : "");

  const [hoursState, setHoursState] = useState(() => parseHoursJson(settings.hours_json));

  const [ig, setIg] = useState(settings.instagram_url ?? "");
  const [fb, setFb] = useState(settings.facebook_url ?? "");
  const [tt, setTt] = useState(settings.tiktok_url ?? "");
  const [tw, setTw] = useState(settings.twitter_url ?? "");
  const [yt, setYt] = useState(settings.youtube_url ?? "");
  const [wa, setWa] = useState(settings.whatsapp_url ?? "");
  const [li, setLi] = useState(settings.linkedin_url ?? "");
  const [confirmEmail, setConfirmEmail] = useState(settings.booking_confirmation_email !== false);
  const [reminderEmail, setReminderEmail] = useState(settings.booking_reminder_email !== false);
  const [reminderHours, setReminderHours] = useState(settings.reminder_hours_before ?? 24);
  const [reviewEmail, setReviewEmail] = useState(settings.review_request_email !== false);

  const [depositsEnabled, setDepositsEnabled] = useState(settings.deposits_enabled === true);
  const [depositPercent, setDepositPercent] = useState(settings.deposit_percent ?? 50);
  const [depositMin, setDepositMin] = useState(
    settings.deposit_min_pence != null ? (settings.deposit_min_pence / 100).toFixed(2) : "5.00"
  );

  const [showIg, setShowIg] = useState(settings.show_instagram === true);
  const [showFb, setShowFb] = useState(settings.show_facebook === true);
  const [showTt, setShowTt] = useState(settings.show_tiktok === true);
  const [showTw, setShowTw] = useState(settings.show_twitter === true);
  const [showYt, setShowYt] = useState(settings.show_youtube === true);
  const [showWa, setShowWa] = useState(settings.show_whatsapp === true);
  const [showLi, setShowLi] = useState(settings.show_linkedin === true);

  const submitPatch = (patch: Record<string, string | number | boolean | null>) => {
    fetcher.submit(patch, { method: "POST", encType: "application/json" });
  };

  const saveContact = () => {
    const patch: Record<string, string | number | boolean | null> = {
      phone: phone.trim(),
      address: address.trim(),
    };
    const latN = lat.trim() === "" ? null : Number(lat);
    const lngN = lng.trim() === "" ? null : Number(lng);
    patch.lat = lat.trim() === "" || Number.isNaN(latN) ? null : latN;
    patch.lng = lng.trim() === "" || Number.isNaN(lngN) ? null : lngN;
    submitPatch(patch);
  };

  const saveHours = () => {
    submitPatch({ hours_json: serializeHoursJson(hoursState) });
  };

  const saveDeposits = () => {
    // Form-input boundary (WS-4): pounds text -> integer pence.
    const minPence = parsePoundsToPence(depositMin) ?? 500;
    submitPatch({
      deposit_percent: depositPercent,
      deposit_min_pence: minPence,
    });
  };

  const saveSocial = () => {
    submitPatch({
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

  if (error === "no_shop" || !shopId) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <h1 className="font-heading text-2xl font-bold text-white">Settings</h1>
        <p className="text-sm text-white/60">
          No shop is linked to your account. Contact support if you need help.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10 pb-12">
      {toast ? (
        <div
          className={clsx(
            "fixed bottom-6 right-6 z-50 max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg",
            toast.type === "success"
              ? "border-emerald-500/40 bg-emerald-950/90 text-emerald-100"
              : "border-red-500/40 bg-red-950/90 text-red-100"
          )}
          role="status"
        >
          {toast.text}
        </div>
      ) : null}

      <h1 className="font-heading text-2xl font-bold text-white">Shop settings</h1>

      {/* Contact */}
      <section className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Contact &amp; location</h2>
        <div className="space-y-4">
          <Input label="Phone number" name="phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <Input label="Address" name="address" value={address} onChange={(e) => setAddress(e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Latitude (optional)" name="lat" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="e.g. 51.5074" />
            <Input label="Longitude (optional)" name="lng" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="e.g. -0.1278" />
          </div>
          {address.trim() ? (
            <div className="rounded-lg border border-white/10 bg-white/5 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-white/50">Map preview</p>
              <p className="mt-2 text-sm text-white/80">{address.trim()}</p>
            </div>
          ) : (
            <p className="text-sm text-white/45">Add an address to see it previewed here.</p>
          )}
        </div>
        <Button type="button" size="sm" onClick={saveContact} disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Save"}
        </Button>
      </section>

      {/* Hours */}
      <section className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Opening hours</h2>
        <div className="space-y-3">
          {DAY_KEYS.map((k) => {
            const row = hoursState[k];
            return (
              <div
                key={k}
                className="flex flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-3 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="w-28 shrink-0 text-sm font-medium text-white/90">{DAY_LABELS[k]}</div>
                <label className="flex cursor-pointer items-center gap-2 text-sm text-white/80">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-white/30 bg-white/5 text-gold focus:ring-gold"
                    checked={row.open}
                    onChange={(e) =>
                      setHoursState((prev) => ({
                        ...prev,
                        [k]: { ...prev[k], open: e.target.checked },
                      }))
                    }
                  />
                  Open
                </label>
                <div className="flex flex-1 flex-wrap items-center gap-2 sm:justify-end">
                  <select
                    className={HOURS_SELECT_CLASS}
                    disabled={!row.open}
                    value={row.start}
                    onChange={(e) =>
                      setHoursState((prev) => ({
                        ...prev,
                        [k]: { ...prev[k], start: e.target.value },
                      }))
                    }
                  >
                    {TIME_OPTIONS.map((t) => (
                      <option key={t} className="bg-dark text-white" value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <span className="text-white/50">to</span>
                  <select
                    className={HOURS_SELECT_CLASS}
                    disabled={!row.open}
                    value={row.end}
                    onChange={(e) =>
                      setHoursState((prev) => ({
                        ...prev,
                        [k]: { ...prev[k], end: e.target.value },
                      }))
                    }
                  >
                    {TIME_OPTIONS.map((t) => (
                      <option key={`e-${t}`} className="bg-dark text-white" value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
        <Button type="button" size="sm" onClick={saveHours} disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Save"}
        </Button>
      </section>

      {/* Social */}
      <section className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Social media</h2>
        <div className="space-y-5">
          <SocialRow
            label="Instagram"
            url={ig}
            onUrlChange={setIg}
            show={showIg}
            onShowChange={setShowIg}
          />
          <SocialRow
            label="Facebook"
            url={fb}
            onUrlChange={setFb}
            show={showFb}
            onShowChange={setShowFb}
          />
          <SocialRow
            label="TikTok"
            url={tt}
            onUrlChange={setTt}
            show={showTt}
            onShowChange={setShowTt}
          />
          <SocialRow
            label="Twitter / X"
            url={tw}
            onUrlChange={setTw}
            show={showTw}
            onShowChange={setShowTw}
          />
          <SocialRow
            label="YouTube"
            url={yt}
            onUrlChange={setYt}
            show={showYt}
            onShowChange={setShowYt}
          />
          <SocialRow
            label="WhatsApp"
            url={wa}
            onUrlChange={setWa}
            show={showWa}
            onShowChange={setShowWa}
          />
          <SocialRow
            label="LinkedIn"
            url={li}
            onUrlChange={setLi}
            show={showLi}
            onShowChange={setShowLi}
          />
        </div>
        <Button type="button" size="sm" onClick={saveSocial} disabled={fetcher.state !== "idle"}>
          {fetcher.state !== "idle" ? "Saving…" : "Save"}
        </Button>
      </section>

      {/* Notification preferences */}
      <section className="space-y-5 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Email notifications</h2>
        <p className="text-sm text-white/40 -mt-2">Control which automated emails are sent to customers.</p>

        {/* Confirmation email */}
        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <p className="text-sm font-medium text-white">Booking confirmation</p>
            <p className="text-xs text-white/40 mt-0.5">Sent immediately when a booking is made</p>
          </div>
          <Toggle
            value={confirmEmail}
            onChange={(v) => { setConfirmEmail(v); submitPatch({ booking_confirmation_email: v }); }}
          />
        </div>

        {/* Reminder email + timing */}
        <div className="space-y-3 border-t border-white/10 pt-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-white">Booking reminder</p>
              <p className="text-xs text-white/40 mt-0.5">Sent before the appointment</p>
            </div>
            <Toggle
              value={reminderEmail}
              onChange={(v) => { setReminderEmail(v); submitPatch({ booking_reminder_email: v }); }}
            />
          </div>
          {reminderEmail && (
            <div className="flex items-center gap-3 pl-1">
              <span className="text-sm text-white/50">Send</span>
              <select
                value={reminderHours}
                onChange={e => {
                  const h = Number(e.target.value);
                  setReminderHours(h);
                  submitPatch({ reminder_hours_before: h });
                }}
                className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {[2, 4, 6, 12, 24, 48, 72].map(h => (
                  <option key={h} value={h} className="bg-dark">{h}h before</option>
                ))}
              </select>
              <span className="text-sm text-white/50">the appointment</span>
            </div>
          )}
        </div>

        {/* Review request */}
        <div className="flex items-center justify-between gap-4 border-t border-white/10 pt-4">
          <div>
            <p className="text-sm font-medium text-white">Review request</p>
            <p className="text-xs text-white/40 mt-0.5">Sent when a booking is marked completed</p>
          </div>
          <Toggle
            value={reviewEmail}
            onChange={(v) => { setReviewEmail(v); submitPatch({ review_request_email: v }); }}
          />
        </div>
      </section>

      {/* Booking deposits */}
      <section className="space-y-5 rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Booking deposits</h2>
        <p className="text-sm text-white/40 -mt-2">
          Take a card deposit when customers book online. Requires Stripe payments to be set up
          (Settings → Payments). The remaining balance is settled at the appointment.
        </p>

        <div className="flex items-center justify-between gap-4 py-1">
          <div>
            <p className="text-sm font-medium text-white">Require a deposit at online booking</p>
            <p className="text-xs text-white/40 mt-0.5">
              The slot is only confirmed once the deposit is paid; abandoned payments free the slot
              after 30 minutes
            </p>
          </div>
          <Toggle
            value={depositsEnabled}
            onChange={(v) => { setDepositsEnabled(v); submitPatch({ deposits_enabled: v }); }}
          />
        </div>

        {depositsEnabled && (
          <div className="space-y-4 border-t border-white/10 pt-4">
            <div className="flex items-center gap-3">
              <span className="text-sm text-white/50">Deposit is</span>
              <select
                value={depositPercent}
                onChange={(e) => setDepositPercent(Number(e.target.value))}
                className="rounded-lg border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                {[10, 20, 25, 30, 40, 50, 75, 100].map((p) => (
                  <option key={p} value={p} className="bg-dark">{p}%</option>
                ))}
              </select>
              <span className="text-sm text-white/50">of the service price</span>
            </div>
            <div className="max-w-xs">
              <Input
                label="Minimum deposit (£)"
                value={depositMin}
                onChange={(e) => setDepositMin(e.target.value)}
                placeholder="5.00"
              />
              <p className="mt-1 text-xs text-white/40">
                Never more than the service price — a high minimum becomes full prepayment.
              </p>
            </div>
            <Button type="button" size="sm" onClick={saveDeposits} disabled={fetcher.state !== "idle"}>
              {fetcher.state !== "idle" ? "Saving…" : "Save"}
            </Button>
          </div>
        )}
      </section>

    </div>
  );
}


function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={value} onClick={() => onChange(!value)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gold ${value ? "bg-gold" : "bg-white/20"}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${value ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

function SocialRow({
  label,
  url,
  onUrlChange,
  show,
  onShowChange,
  placeholder = "https://…",
  hint,
}: {
  label: string;
  url: string;
  onUrlChange: (v: string) => void;
  show: boolean;
  onShowChange: (v: boolean) => void;
  placeholder?: string;
  hint?: string;
}) {
  const hasUrl = url.trim().length > 0;
  return (
    <div className="space-y-2">
      <Input label={label} type="url" value={url} onChange={(e) => onUrlChange(e.target.value)} placeholder={placeholder} />
      {hint && !hasUrl && <p className="text-xs text-white/30">{hint}</p>}
      {hasUrl ? (
        <div className="flex items-center gap-3">
          <span className="text-xs text-white/50">Show on site</span>
          <select
            className={TOGGLE_SELECT_CLASS}
            value={show ? "show" : "hide"}
            onChange={(e) => onShowChange(e.target.value === "show")}
          >
            <option className="bg-dark text-white" value="show">
              Show
            </option>
            <option className="bg-dark text-white" value="hide">
              Hide
            </option>
          </select>
        </div>
      ) : null}
    </div>
  );
}
