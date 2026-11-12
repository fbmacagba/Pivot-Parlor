// apps/web/app/routes/admin.waitlist.tsx
import { useFetcher, useLoaderData } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatDay } from "~/lib/dateFormat";

// ─── Types ────────────────────────────────────────────────────────────────────

interface WaitlistEntry {
  id: string;
  shop_id: string;
  staff_id: string | null;
  service_id: string | null;
  customer_name: string;
  customer_email: string;
  customer_phone: string | null;
  preferred_date: string | null;
  status: string;
  created_at: string;
  service_name: string | null;
}

type ActionData = { ok: true } | { error: string };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);

  let entries: WaitlistEntry[] = [];
  let loadError = false;
  if (shopId) {
    try {
      entries = await api.get<WaitlistEntry[]>(`/api/waitlist?shop_id=${shopId}`);
    } catch {
      // Distinguish "could not load" from "genuinely empty" in the UI.
      loadError = true;
    }
  }

  return json({
    entries,
    shopId,
    loadError,
    developerNeedsShop: user.role === "developer" && !shopId,
  });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json<ActionData>({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "").trim();
  const entryId = String(form.get("entryId") ?? "").trim();
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = pageShopId(request, user, formShopId);

  if (!shopId) {
    return json<ActionData>(
      { error: "Missing shop. Admins need a linked shop; developers add ?shopId= to the URL." },
      { status: 400 }
    );
  }
  if (!entryId) return json<ActionData>({ error: "Missing entry." }, { status: 400 });

  const api = createApiClient(env.API_URL, token);

  try {
    if (intent === "notify") {
      await api.post(`/api/waitlist/${entryId}/notify`, {});
      return json<ActionData>({ ok: true });
    }
    if (intent === "setStatus") {
      const status = String(form.get("status") ?? "").trim();
      if (!["waiting", "booked", "expired"].includes(status)) {
        return json<ActionData>({ error: "Invalid status." }, { status: 400 });
      }
      await api.patch(`/api/waitlist/${entryId}/status`, { status });
      return json<ActionData>({ ok: true });
    }
  } catch (e: unknown) {
    // Surfaces worker errors like "Email sending is not configured" (503)
    // or "Failed to send notification email" (502) to the admin.
    const message = e instanceof Error ? e.message : "Something went wrong";
    return json<ActionData>({ error: message }, { status: 502 });
  }

  return json<ActionData>({ error: "Unknown action." }, { status: 400 });
}

// ─── UI ───────────────────────────────────────────────────────────────────────

const STATUS_META: Record<string, { label: string; classes: string }> = {
  waiting: { label: "Waiting", classes: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  notified: { label: "Notified", classes: "bg-gold/15 text-gold border-gold/30" },
  booked: { label: "Booked", classes: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  expired: { label: "Expired", classes: "bg-white/5 text-white/60 border-white/15" },
};

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / (60 * 24))}d ago`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "Any date";
  return formatDay(iso, { weekday: "short", day: "numeric", month: "short" });
}

function EntryRow({ entry, shopId }: { entry: WaitlistEntry; shopId: string | null }) {
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";
  const meta = STATUS_META[entry.status] ?? STATUS_META.waiting;
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  const actionButton = (
    intent: string,
    label: string,
    classes: string,
    status?: string
  ) => (
    <fetcher.Form method="post" className="inline">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="entryId" value={entry.id} />
      {shopId && <input type="hidden" name="shopId" value={shopId} />}
      {status && <input type="hidden" name="status" value={status} />}
      <button
        type="submit"
        disabled={busy}
        className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50 ${classes}`}
      >
        {label}
      </button>
    </fetcher.Form>
  );

  return (
    <div className="px-5 py-4 hover:bg-white/[0.02] transition-colors">
      <div className="flex flex-wrap items-center gap-4">
        {/* Avatar */}
        <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center font-semibold text-white/60 text-sm shrink-0">
          {entry.customer_name.charAt(0).toUpperCase()}
        </div>
        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-white truncate">{entry.customer_name}</p>
            <span className={`px-2 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide ${meta.classes}`}>
              {meta.label}
            </span>
          </div>
          <p className="text-xs text-white/60 truncate">
            {entry.customer_email}
            {entry.customer_phone ? ` · ${entry.customer_phone}` : ""}
          </p>
          <p className="text-xs text-white/50 mt-0.5">
            {formatDate(entry.preferred_date)}
            {entry.service_name ? ` · ${entry.service_name}` : ""}
            {` · joined ${timeAgo(entry.created_at)}`}
          </p>
        </div>
        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          {entry.status === "waiting" && (
            <>
              {actionButton("notify", busy ? "Sending…" : "Notify", "bg-gold/20 text-gold hover:bg-gold/30")}
              {actionButton("setStatus", "Mark booked", "text-white/60 hover:text-emerald-400 hover:bg-emerald-500/10", "booked")}
              {actionButton("setStatus", "Expire", "text-white/50 hover:text-white/70 hover:bg-white/5", "expired")}
            </>
          )}
          {entry.status === "notified" && (
            <>
              {actionButton("setStatus", "Mark booked", "bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30", "booked")}
              {actionButton("setStatus", "Back to waiting", "text-white/60 hover:text-white/80 hover:bg-white/5", "waiting")}
              {actionButton("setStatus", "Expire", "text-white/50 hover:text-white/70 hover:bg-white/5", "expired")}
            </>
          )}
          {(entry.status === "booked" || entry.status === "expired") &&
            actionButton("setStatus", "Back to waiting", "text-white/60 hover:text-white/80 hover:bg-white/5", "waiting")}
        </div>
      </div>
      {error && (
        <p className="mt-2 ml-12 text-xs text-red-400">{error}</p>
      )}
    </div>
  );
}

export default function AdminWaitlist() {
  const { entries, shopId, loadError, developerNeedsShop } = useLoaderData<typeof loader>();

  const waiting = entries.filter((e) => e.status === "waiting");
  const notified = entries.filter((e) => e.status === "notified");
  const closed = entries.filter((e) => e.status === "booked" || e.status === "expired");

  if (developerNeedsShop) {
    return (
      <div className="rounded-xl border border-white/10 bg-dark-100 p-8 text-center">
        <h1 className="font-heading text-xl font-bold text-white mb-2">Waitlist</h1>
        <p className="text-sm text-white/60">
          Developers: add <code className="text-gold">?shopId=&lt;shop id&gt;</code> to the URL to
          view a shop&apos;s waitlist.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">Waitlist</h1>
        <p className="mt-0.5 text-sm text-white/60">
          {waiting.length} waiting · {notified.length} notified. Customers are also notified
          automatically when a matching booking is cancelled.
        </p>
      </div>

      {loadError && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          The waitlist could not be loaded. Refresh to try again.
        </div>
      )}

      {/* Open entries */}
      <div>
        <h2 className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-3">
          Open {waiting.length + notified.length > 0 ? `(${waiting.length + notified.length})` : ""}
        </h2>
        {waiting.length + notified.length === 0 ? (
          loadError ? null : (
            <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/50 text-sm">
              No one is on the waitlist right now. Customers join from your public site when
              slots are full.
            </div>
          )
        ) : (
          <div className="rounded-xl border border-white/10 bg-dark-100 divide-y divide-white/5 overflow-hidden">
            {[...waiting, ...notified].map((entry) => (
              <EntryRow key={entry.id} entry={entry} shopId={shopId} />
            ))}
          </div>
        )}
      </div>

      {/* Closed entries */}
      {closed.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-3">
            Closed ({closed.length})
          </h2>
          <div className="rounded-xl border border-white/10 bg-dark-100 divide-y divide-white/5 overflow-hidden">
            {closed.map((entry) => (
              <EntryRow key={entry.id} entry={entry} shopId={shopId} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
