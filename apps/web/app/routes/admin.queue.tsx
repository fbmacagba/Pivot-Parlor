// apps/web/app/routes/admin.queue.tsx
import { useLoaderData, useFetcher, useRevalidator, data as json } from "react-router";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useState } from "react";
import QRCode from "react-qr-code";
import { QrCode, UserPlus } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { pageShopId } from "~/lib/pageShop";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { usePolling } from "~/lib/usePolling";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { ErrorScreen } from "~/components/ErrorScreen";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Walk-in queue");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

interface QueueEntry {
  id: string;
  name: string;
  phone: string | null;
  service: string | null;
  position: number;
  status: string;
  notes: string | null;
  created_at: string;
}

type ActionResult =
  | { ok: true; intent: "updateStatus"; entryId: string; status: string }
  | { ok: true; intent: "clearQueue" }
  | { ok: true; intent: "addWalkin"; name: string; position: number | null }
  | { ok: false; error: string; intent?: string; entryId?: string };

const ENTRY_STATUSES = ["waiting", "serving", "served", "skipped", "removed"];

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user);

  let queue: QueueEntry[] = [];
  let shopSlug = "";
  let loadError = false;
  if (shopId) {
    const [queueRes, shopRes] = await Promise.allSettled([
      // With the entries skipped in the last 12 hours, so a skipped customer
      // who comes back can still be returned to the queue after a reload.
      api.get<QueueEntry[]>(`/api/shops/${shopId}/walkin?include_skipped=1`),
      api.get<{ slug: string }>(`/api/shops/${shopId}`),
    ]);
    if (queueRes.status === "fulfilled") queue = queueRes.value ?? [];
    else loadError = true;
    if (shopRes.status === "fulfilled") shopSlug = shopRes.value?.slug ?? "";
  }

  // The public address customers scan, built from the address this page was
  // asked at, so staging, a preview and production each print their own.
  const walkinUrl = shopSlug ? `${new URL(request.url).origin}/${shopSlug}/walkin` : "";

  // shopSlug stays in the loader data: the E2E dashboard sweep reads it.
  return json({ queue, shopId, shopSlug, walkinUrl, loadError });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const form = await readFormData(request);
  if (!form) return json<ActionResult>({ ok: false, error: UNREADABLE_FORM }, 400);
  const shopId = pageShopId(request, user, String(form.get("shopId") ?? "") || null);
  if (!shopId) return json<ActionResult>({ ok: false, error: "No shop is selected for this page." }, 400);
  const intent = String(form.get("intent") ?? "");

  if (intent === "updateStatus") {
    const entryId = String(form.get("entryId") ?? "");
    const status = String(form.get("status") ?? "");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(entryId) || !ENTRY_STATUSES.includes(status)) {
      return json<ActionResult>({ ok: false, error: "That queue change was not understood. Refresh and try again.", intent, entryId }, 400);
    }
    try {
      await api.patch(`/api/shops/${shopId}/walkin/${entryId}`, { status });
      return json<ActionResult>({ ok: true, intent, entryId, status });
    } catch (e) {
      return json<ActionResult>(
        {
          ok: false,
          intent,
          entryId,
          error: `The queue was not updated: ${e instanceof Error ? e.message : "the request failed"}. Try again.`,
        },
        400,
      );
    }
  }
  if (intent === "addWalkin") {
    const name = String(form.get("name") ?? "").trim();
    const service = String(form.get("service") ?? "").trim();
    if (!name) return json<ActionResult>({ ok: false, intent, error: "Enter the customer's name." }, 400);
    if (name.length > 120) {
      return json<ActionResult>({ ok: false, intent, error: "That name is too long. Keep it to 120 characters." }, 400);
    }
    if (service.length > 120) {
      return json<ActionResult>({ ok: false, intent, error: "That service is too long. Keep it to 120 characters." }, 400);
    }
    try {
      const added = await api.post<{ id: string; position: number }>(`/api/shops/${shopId}/walkin`, {
        name,
        ...(service ? { service } : {}),
      });
      return json<ActionResult>({
        ok: true,
        intent,
        name,
        position: typeof added?.position === "number" ? added.position : null,
      });
    } catch (e) {
      return json<ActionResult>(
        {
          ok: false,
          intent,
          error: `${name} was not added to the queue: ${e instanceof Error ? e.message : "the request failed"}. Try again.`,
        },
        400,
      );
    }
  }
  if (intent === "clearQueue") {
    try {
      await api.del(`/api/shops/${shopId}/walkin`);
      return json<ActionResult>({ ok: true, intent });
    } catch (e) {
      return json<ActionResult>(
        {
          ok: false,
          intent,
          error: `The queue was not cleared: ${e instanceof Error ? e.message : "the request failed"}. Try again.`,
        },
        400,
      );
    }
  }
  return json<ActionResult>({ ok: false, error: "That action was not understood." }, 400);
}

function timeAgo(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/**
 * The list the page shows: what the server last sent, with the change still
 * in flight laid over it. Dropping the overlay (the request failed) is the
 * rollback; nothing else has to be undone.
 */
function applyPendingStatuses(queue: QueueEntry[], pending: Record<string, string>): QueueEntry[] {
  return queue.map((e) => (pending[e.id] ? { ...e, status: pending[e.id] } : e));
}

/** Drawn in the browser: the shop's address never leaves for a QR service.
 *  Dark modules on a white tile with a quiet zone, which every scanner reads. */
function WalkinQr({ url }: { url: string }) {
  return (
    <div className="shrink-0 rounded-xl bg-white p-4">
      <QRCode value={url} size={168} bgColor="#ffffff" fgColor="#000000" title="QR code to join the walk-in queue" />
    </div>
  );
}

/** Adds someone who walked in and has no phone to scan with. */
function AddWalkinForm({ shopId }: { shopId: string | null }) {
  const fetcher = useFetcher<ActionResult>();
  const [name, setName] = useState("");
  const [service, setService] = useState("");
  const [result, setResult] = useState<ActionResult | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    setResult(data);
    if (data.ok) {
      setName("");
      setService("");
    }
  });

  return (
    <section aria-labelledby="queue-add" className="rounded-xl border border-white/10 bg-dark-100 p-5">
      <h2 id="queue-add" className="mb-3 text-sm font-semibold text-white">Add a walk-in</h2>
      <fetcher.Form method="post" className="flex flex-wrap items-end gap-3" onSubmit={() => setResult(null)}>
        <input type="hidden" name="intent" value="addWalkin" />
        {shopId && <input type="hidden" name="shopId" value={shopId} />}
        <div className="min-w-[10rem] flex-1">
          <Input
            label="Name"
            name="name"
            required
            maxLength={120}
            autoComplete="off"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="min-w-[10rem] flex-1">
          <Input
            label="Service (optional)"
            name="service"
            maxLength={120}
            autoComplete="off"
            placeholder="e.g. skin fade"
            value={service}
            onChange={(e) => setService(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={busy || !shopId || name.trim() === ""}>
          <UserPlus className="h-4 w-4" aria-hidden />
          {busy ? "Adding…" : "Add to queue"}
        </Button>
      </fetcher.Form>
      {result?.ok && result.intent === "addWalkin" && (
        <p role="status" className="mt-3 text-sm text-emerald-300">
          {result.name} added to the queue{result.position ? ` at position ${result.position}` : ""}.
        </p>
      )}
      {result && !result.ok && (
        <p role="alert" className="mt-3 text-sm text-red-400">
          {result.error}
        </p>
      )}
    </section>
  );
}

export default function AdminQueue() {
  const { queue: loaded, shopId, walkinUrl, loadError } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionResult>();
  const revalidator = useRevalidator();
  const [showQR, setShowQR] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Changes sent but not yet answered, by entry id.
  const [pending, setPending] = useState<Record<string, string>>({});

  const busy = fetcher.state !== "idle";

  usePolling(() => revalidator.revalidate(), { intervalMs: 30_000, enabled: Boolean(shopId) && !busy });

  useFetcherResult(fetcher, (result) => {
    // The loader has reloaded by now, so the overlay is no longer needed
    // (success) or must be dropped (failure: the entry returns as it was).
    setPending({});
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    if (result.intent === "clearQueue") setConfirmClear(false);
  });

  function updateStatus(entry: QueueEntry, status: string) {
    setError(null);
    setPending((p) => ({ ...p, [entry.id]: status }));
    const form = new FormData();
    form.append("intent", "updateStatus");
    form.append("entryId", entry.id);
    form.append("status", status);
    fetcher.submit(form, { method: "post" });
  }

  function clearQueue() {
    setError(null);
    const form = new FormData();
    form.append("intent", "clearQueue");
    fetcher.submit(form, { method: "post" });
  }

  const queue = applyPendingStatuses(loaded as QueueEntry[], pending);
  const waiting = queue.filter((e) => e.status === "waiting");
  const serving = queue.filter((e) => e.status === "serving");
  // From the loader (the last 12 hours), so the group survives a reload.
  const skippedShown = queue.filter((e) => e.status === "skipped");
  const liveCount = waiting.length + serving.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Walk-in queue</h1>
          <p className="mt-0.5 text-sm text-white/60">
            {loadError
              ? "Refreshes every 30 seconds"
              : `${waiting.length} waiting · ${serving.length} being served · refreshes every 30 seconds`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setShowQR((v) => !v)}
            aria-expanded={showQR}
            disabled={!walkinUrl}
          >
            <QrCode className="h-4 w-4" aria-hidden />
            {showQR ? "Hide QR code" : "Show QR code"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setConfirmClear(true)}
            disabled={loadError || liveCount === 0}
          >
            Clear queue
          </Button>
        </div>
      </div>

      {error && !confirmClear && (
        <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </p>
      )}

      <ConfirmDialog
        open={confirmClear}
        onCancel={() => {
          setConfirmClear(false);
          setError(null);
        }}
        onConfirm={clearQueue}
        title="Clear the whole queue?"
        confirmLabel="Clear queue"
        destructive
        pending={busy}
        pendingLabel="Clearing…"
        error={confirmClear ? error : null}
      >
        <p>
          {liveCount === 1 ? "1 person" : `${liveCount} people`} will be removed from the queue, including anyone being
          served. Customers watching their place on their phone will see they have been removed.
        </p>
        <p>This cannot be undone.</p>
      </ConfirmDialog>

      {/* QR code panel */}
      {showQR && walkinUrl && (
        <div className="flex flex-col items-center gap-6 rounded-xl border border-white/10 bg-dark-100 p-6 sm:flex-row">
          <WalkinQr url={walkinUrl} />
          <div className="min-w-0">
            <h2 className="mb-1 font-semibold text-white">Walk-in QR code</h2>
            <p className="mb-3 text-sm text-white/70">Customers scan this to join the queue from their phone.</p>
            <a
              href={walkinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tap-target inline-flex items-center break-all text-sm text-gold hover:underline"
            >
              {walkinUrl}
            </a>
            <p className="mt-3 text-xs text-white/60">Print and display at your entrance or counter.</p>
          </div>
        </div>
      )}

      <AddWalkinForm shopId={shopId} />

      {loadError ? (
        <LoadError what="the walk-in queue" />
      ) : (
        <>
          {/* Currently serving */}
          {serving.length > 0 && (
            <section aria-labelledby="queue-serving">
              <h2 id="queue-serving" className="mb-3 text-xs font-semibold uppercase tracking-wider text-gold">
                Now serving
              </h2>
              <ul className="space-y-2">
                {serving.map((entry) => (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-gold/25 bg-gold/5 px-5 py-4"
                  >
                    <div aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gold/20 text-sm font-bold text-gold">
                      {entry.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-[9rem] flex-1">
                      <p className="font-semibold text-white">{entry.name}</p>
                      {entry.service && <p className="text-xs text-white/60">{entry.service}</p>}
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      className="ml-auto"
                      onClick={() => updateStatus(entry, "served")}
                      disabled={busy}
                    >
                      Mark served
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Waiting queue */}
          <section aria-labelledby="queue-waiting">
            <h2 id="queue-waiting" className="mb-3 text-xs font-semibold uppercase tracking-wider text-white/60">
              Waiting {waiting.length > 0 ? `(${waiting.length})` : ""}
            </h2>
            {waiting.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/10 p-10 text-center text-sm text-white/60">
                Nobody is waiting. Show the QR code so customers can join the queue.
              </div>
            ) : (
              <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-dark-100">
                {waiting.map((entry, i) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4 transition-colors hover:bg-white/[0.02]">
                    {/* Position */}
                    <div className="w-8 shrink-0 text-center">
                      <span className="text-lg font-bold text-white/60">
                        <span className="sr-only">Position </span>
                        {entry.position}
                      </span>
                    </div>
                    {/* Info */}
                    <div className="min-w-[9rem] flex-1">
                      <p className="font-medium text-white">{entry.name}</p>
                      <p className="text-xs text-white/60">
                        {entry.service ? `${entry.service} · ` : ""}
                        {timeAgo(entry.created_at)}
                        {entry.phone ? ` · ${entry.phone}` : ""}
                      </p>
                    </div>
                    {/* Actions */}
                    <div className="ml-auto flex shrink-0 flex-wrap items-center gap-2">
                      {i === 0 && (
                        <Button type="button" size="sm" onClick={() => updateStatus(entry, "serving")} disabled={busy}>
                          Call next
                        </Button>
                      )}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => updateStatus(entry, "skipped")}
                        disabled={busy}
                        aria-label={`Skip ${entry.name}`}
                      >
                        Skip
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => updateStatus(entry, "removed")}
                        disabled={busy}
                        aria-label={`Remove ${entry.name} from the queue`}
                      >
                        Remove
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Skipped in the last 12 hours */}
          {skippedShown.length > 0 && (
            <section aria-labelledby="queue-skipped">
              <h2 id="queue-skipped" className="mb-1 text-xs font-semibold uppercase tracking-wider text-white/60">
                Skipped ({skippedShown.length})
              </h2>
              <p className="mb-3 text-xs text-white/60">
                People skipped in the last 12 hours. Return someone when they are back in the shop.
              </p>
              <ul className="divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10 bg-dark-100">
                {skippedShown.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="font-medium text-white/80">{entry.name}</p>
                      <p className="text-xs text-white/60">
                        {entry.service ? `${entry.service} · ` : ""}
                        joined {timeAgo(entry.created_at)}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      className="ml-auto"
                      onClick={() => updateStatus(entry, "waiting")}
                      disabled={busy}
                      aria-label={`Return ${entry.name} to the queue`}
                    >
                      Return to queue
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
