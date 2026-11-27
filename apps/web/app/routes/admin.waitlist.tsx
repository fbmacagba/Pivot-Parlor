// apps/web/app/routes/admin.waitlist.tsx
import { useFetcher, useLoaderData, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useState } from "react";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatDay } from "~/lib/dateFormat";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { Button, type ButtonProps } from "~/components/ui/Button";
import { LoadError } from "~/components/ui/LoadError";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { ErrorScreen } from "~/components/ErrorScreen";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Waitlist");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

/** Closed entries are shown this many at a time. */
const CLOSED_PAGE = 20;

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

  const form = await readFormData(request);
  if (!form) return json<ActionData>({ error: UNREADABLE_FORM }, { status: 400 });
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
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  const actionButton = (
    intent: string,
    label: string,
    variant: ButtonProps["variant"],
    status?: string
  ) => (
    <fetcher.Form method="post" className="inline">
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="entryId" value={entry.id} />
      {shopId && <input type="hidden" name="shopId" value={shopId} />}
      {status && <input type="hidden" name="status" value={status} />}
      <Button type="submit" size="sm" variant={variant} disabled={busy} aria-label={`${label}: ${entry.customer_name}`}>
        {label}
      </Button>
    </fetcher.Form>
  );

  return (
    <div className="px-5 py-4 hover:bg-white/[0.02] transition-colors">
      <div className="flex flex-wrap items-center gap-4">
        {/* Avatar */}
        <div aria-hidden className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center font-semibold text-white/60 text-sm shrink-0">
          {entry.customer_name.charAt(0).toUpperCase()}
        </div>
        {/* Info */}
        <div className="min-w-[9rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium text-white truncate">{entry.customer_name}</p>
            <StatusBadge status={entry.status} />
          </div>
          <p className="text-xs text-white/60 truncate">
            {entry.customer_email}
            {entry.customer_phone ? ` · ${entry.customer_phone}` : ""}
          </p>
          <p className="text-xs text-white/60 mt-0.5">
            {formatDate(entry.preferred_date)}
            {entry.service_name ? ` · ${entry.service_name}` : ""}
            {` · joined ${timeAgo(entry.created_at)}`}
          </p>
        </div>
        {/* Actions */}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {entry.status === "waiting" && (
            <>
              {actionButton("notify", busy ? "Sending…" : "Notify", "default")}
              {actionButton("setStatus", "Mark booked", "secondary", "booked")}
              {actionButton("setStatus", "Expire", "ghost", "expired")}
            </>
          )}
          {entry.status === "notified" && (
            <>
              {actionButton("setStatus", "Mark booked", "default", "booked")}
              {actionButton("setStatus", "Back to waiting", "secondary", "waiting")}
              {actionButton("setStatus", "Expire", "ghost", "expired")}
            </>
          )}
          {(entry.status === "booked" || entry.status === "expired") &&
            actionButton("setStatus", "Back to waiting", "secondary", "waiting")}
        </div>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-400 sm:ml-12">{error}</p>
      )}
    </div>
  );
}

export default function AdminWaitlist() {
  const { entries, shopId, loadError, developerNeedsShop } = useLoaderData<typeof loader>();

  const waiting = entries.filter((e) => e.status === "waiting");
  const notified = entries.filter((e) => e.status === "notified");
  const closed = entries.filter((e) => e.status === "booked" || e.status === "expired");
  const [closedShown, setClosedShown] = useState(CLOSED_PAGE);

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
          {loadError ? "" : `${waiting.length} waiting · ${notified.length} notified. `}Customers are also notified
          automatically when a matching booking is cancelled.
        </p>
      </div>

      {loadError && <LoadError what="the waitlist" />}

      {/* Open entries */}
      <div>
        <h2 className="text-xs font-semibold text-white/60 uppercase tracking-wider mb-3">
          Open {waiting.length + notified.length > 0 ? `(${waiting.length + notified.length})` : ""}
        </h2>
        {waiting.length + notified.length === 0 ? (
          loadError ? null : (
            <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-white/60 text-sm">
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
            {closed.slice(0, closedShown).map((entry) => (
              <EntryRow key={entry.id} entry={entry} shopId={shopId} />
            ))}
          </div>
          {closed.length > closedShown && (
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <Button type="button" variant="secondary" size="sm" onClick={() => setClosedShown((n) => n + CLOSED_PAGE)}>
                Show more
              </Button>
              <p className="text-xs text-white/60">
                Showing {closedShown} of {closed.length}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
