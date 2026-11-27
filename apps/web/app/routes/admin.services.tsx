import { useFetcher, useLoaderData, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Plus, Pencil, RotateCcw } from "lucide-react";
import { useState } from "react";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence, parsePoundsToPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { ErrorScreen } from "~/components/ErrorScreen";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/Dialog";
import { DURATION_ERROR, parseDurationMinutes } from "~/components/admin/serviceForm";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Services");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** The services list's public shape (camelCase durationMinutes and isActive). */
interface Service {
  id: string;
  shopId: string;
  name: string;
  description: string;
  durationMinutes: number;
  price_pence: number;
  category: string;
  isActive: boolean;
}

/** Every answer names the intent it is for, so a dialog only shows its own outcome. */
type ActionData =
  | { ok: true; intent: string; message: string }
  | { ok: false; intent: string; error: string };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);

  let services: Service[] = [];
  let loadError = false;
  if (shopId) {
    try {
      // Deactivated services come too, so the owner can restore one.
      services = await api.get<Service[]>(`/api/shops/${shopId}/services?include_inactive=1`);
    } catch {
      loadError = true;
    }
  }

  return json({
    services,
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
  const fail = (intent: string, error: string, status = 400) =>
    json<ActionData>({ ok: false, intent, error }, { status });
  const done = (intent: string, message: string) => json<ActionData>({ ok: true, intent, message });
  if (!token) return fail("", "You are signed out. Sign in again to continue.", 401);

  const form = await readFormData(request);
  if (!form) return fail("", UNREADABLE_FORM);
  const intent = String(form.get("intent") ?? "").trim();
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = pageShopId(request, user, formShopId);

  if (!shopId) {
    return fail(intent, "Missing shop. Admins need a linked shop; developers add ?shopId=… to the URL.");
  }

  const api = createApiClient(env.API_URL, token);

  // ── CREATE and UPDATE share one set of field checks ──
  if (intent === "create" || intent === "update") {
    const serviceId = String(form.get("serviceId") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const category = String(form.get("category") ?? "").trim();

    if (intent === "update" && !serviceId) {
      return fail(intent, "That service could not be found. Reload the page and try again.");
    }
    if (!name) return fail(intent, "Enter a name for the service.");
    const pricePence = parsePoundsToPence(String(form.get("price") ?? ""));
    if (pricePence === null) return fail(intent, "Enter the price in pounds, for example 25 or 25.50.");
    const durationMin = parseDurationMinutes(String(form.get("duration_min") ?? ""));
    if (durationMin === null) return fail(intent, DURATION_ERROR);

    try {
      if (intent === "create") {
        await api.post(`/api/shops/${shopId}/services`, {
          name,
          category: category || undefined,
          price_pence: pricePence,
          duration_min: durationMin,
        });
      } else {
        await api.put(`/api/shops/${shopId}/services/${serviceId}`, {
          name,
          category: category || null,
          price_pence: pricePence,
          duration_min: durationMin,
        });
      }
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The service could not be saved. Try again.");
    }
    return done(intent, intent === "create" ? `${name} added.` : `${name} saved.`);
  }

  // ── DEACTIVATE (soft delete) ──
  if (intent === "deactivate") {
    const serviceId = String(form.get("serviceId") ?? "").trim();
    if (!serviceId) return fail(intent, "That service could not be found. Reload the page and try again.");
    try {
      await api.del(`/api/shops/${shopId}/services/${serviceId}`);
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The service could not be deactivated. Try again.");
    }
    return done(intent, "Service deactivated. Restore it from the inactive list.");
  }

  // ── RESTORE ──
  if (intent === "restore") {
    const serviceId = String(form.get("serviceId") ?? "").trim();
    if (!serviceId) return fail(intent, "That service could not be found. Reload the page and try again.");
    try {
      await api.put(`/api/shops/${shopId}/services/${serviceId}`, { is_active: 1 });
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The service could not be restored. Try again.");
    }
    return done(intent, "Service restored.");
  }

  return fail(intent, "That action is not recognised. Reload the page and try again.");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDuration(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function AdminServices() {
  const { services, shopId, loadError, developerNeedsShop } = useLoaderData<typeof loader>();

  const [addOpen, setAddOpen] = useState(false);
  const [editService, setEditService] = useState<Service | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const active = services.filter((s) => s.isActive);
  const inactive = services.filter((s) => !s.isActive);

  // Group the active services by category
  const grouped = active.reduce<Record<string, Service[]>>((acc, svc) => {
    const key = svc.category || "Uncategorised";
    if (!acc[key]) acc[key] = [];
    acc[key].push(svc);
    return acc;
  }, {});

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Services</h1>
          {!loadError && (
            <p className="mt-0.5 text-sm text-white/60">
              {active.length} active
              {inactive.length > 0 && ` · ${inactive.length} inactive`}
            </p>
          )}
        </div>
        <Button size="sm" disabled={developerNeedsShop || loadError} onClick={() => setAddOpen(true)}>
          <Plus className="h-4 w-4" aria-hidden /> Add service
        </Button>
      </div>

      {/* The outcome of the last action. Always mounted, so a screen reader hears it arrive. */}
      <div role="status" className={notice ? "mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" : "sr-only"}>
        {notice}
      </div>

      {/* Developer hint */}
      {developerNeedsShop && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage services as a developer.
        </div>
      )}

      {/* Add dialog. Its form mounts with the dialog, so each opening starts clean. */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New service</DialogTitle>
          </DialogHeader>
          {addOpen && (
            <ServiceForm
              intent="create"
              shopId={shopId}
              submitLabel="Add service"
              onDone={(message) => {
                setAddOpen(false);
                setNotice(message);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog
        open={!!editService}
        onOpenChange={(open) => { if (!open) setEditService(null); }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit service</DialogTitle>
          </DialogHeader>
          {editService && (
            <ServiceForm
              key={editService.id}
              intent="update"
              shopId={shopId}
              service={editService}
              submitLabel="Save changes"
              onDone={(message) => {
                setEditService(null);
                setNotice(message);
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Service list */}
      {loadError ? (
        <LoadError what="your services" />
      ) : active.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-12 text-center text-white/70">
          <p className="text-lg">{inactive.length > 0 ? "No active services." : "No services yet."}</p>
          <p className="mt-1 text-sm text-white/60">
            {inactive.length > 0
              ? "Restore one from the inactive list below, or add a new service."
              : "Use Add service to list the first thing customers can book."}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([category, svcs]) => (
            <div key={category}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/60">
                {category}
              </h2>
              <div className="space-y-2">
                {svcs.map((svc) => (
                  <ServiceRow
                    key={svc.id}
                    service={svc}
                    shopId={shopId}
                    onEdit={() => setEditService(svc)}
                    onNotice={setNotice}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Inactive services, collapsed until asked for */}
      {!loadError && inactive.length > 0 && (
        <section className="mt-6">
          <button
            type="button"
            aria-expanded={showInactive}
            onClick={() => setShowInactive((v) => !v)}
            className="tap-target inline-flex items-center rounded-lg text-sm text-white/70 underline-offset-4 transition-colors hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            {showInactive ? "Hide inactive" : `Show ${inactive.length} inactive`}
          </button>
          {showInactive && (
            <div className="mt-2 space-y-2">
              {inactive.map((svc) => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  shopId={shopId}
                  onEdit={() => setEditService(svc)}
                  onNotice={setNotice}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

// ─── ServiceRow ───────────────────────────────────────────────────────────────

function ServiceRow({
  service,
  shopId,
  onEdit,
  onNotice,
}: {
  service: Service;
  shopId: string | null;
  onEdit: () => void;
  onNotice: (message: string) => void;
}) {
  const inactive = !service.isActive;
  const fetcher = useFetcher<ActionData>();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      setConfirmOpen(false);
      onNotice(
        data.intent === "restore"
          ? `${service.name} restored.`
          : `${service.name} deactivated. Restore it from the inactive list.`,
      );
    } else {
      setError(data.error);
    }
  });

  function submit(intent: "deactivate" | "restore") {
    setError(null);
    fetcher.submit(
      { intent, serviceId: service.id, ...(shopId ? { shopId } : {}) },
      { method: "post" },
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4 transition-colors ${
        inactive ? "border-white/10 bg-white/[0.03]" : "border-white/10 bg-dark-100 hover:border-white/20"
      }`}
    >
      {/* Info */}
      <div className="min-w-[9rem] flex-1">
        <p className={`truncate text-sm font-medium ${inactive ? "text-white/70" : "text-white"}`}>
          {service.name}
          {inactive && <span className="ml-2 text-xs font-normal text-white/60">(inactive)</span>}
        </p>
        {service.category && (
          <p className="mt-0.5 truncate text-xs text-white/60">{service.category}</p>
        )}
      </div>

      {/* Price + duration */}
      <div className="shrink-0 text-right">
        <p className={`text-sm font-semibold ${inactive ? "text-white/70" : "text-gold"}`}>
          {formatPence(service.price_pence)}
        </p>
        <p className="text-xs text-white/60">
          {formatDuration(service.durationMinutes)}
        </p>
      </div>

      {/* Actions */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onEdit} aria-label={`Edit ${service.name}`}>
          <Pencil className="h-3 w-3" aria-hidden /> Edit
        </Button>
        {inactive ? (
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => submit("restore")} aria-label={`Restore ${service.name}`}>
            <RotateCcw className="h-3 w-3" aria-hidden /> {busy ? "Restoring…" : "Restore"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-red-300 hover:bg-red-500/10"
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
            aria-label={`Deactivate ${service.name}`}
          >
            Deactivate
          </Button>
        )}
      </div>

      {/* A refused restore says so on the row it belongs to. */}
      {error && !busy && !confirmOpen && (
        <p role="alert" className="w-full text-xs text-red-400">{error}</p>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => submit("deactivate")}
        title={`Deactivate ${service.name}?`}
        confirmLabel={`Deactivate ${service.name}`}
        destructive
        pending={busy}
        pendingLabel="Deactivating…"
        error={error}
      >
        <p>Customers will no longer be able to book it, and it comes off your service list. Bookings already made for it are not changed.</p>
        <p>This can be undone: restore it from the inactive list on this page.</p>
      </ConfirmDialog>
    </div>
  );
}

// ─── ServiceForm ──────────────────────────────────────────────────────────────

/** The add and edit form. Each has its own fetcher, so an error from one
 *  attempt is never shown in another dialog. */
function ServiceForm({
  intent,
  shopId,
  service,
  submitLabel,
  onDone,
}: {
  intent: "create" | "update";
  shopId: string | null;
  service?: Service;
  submitLabel: string;
  onDone: (message: string) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.ok) onDone(data.message);
  });

  return (
    <fetcher.Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value={intent} />
      {service && <input type="hidden" name="serviceId" value={service.id} />}
      {shopId && <input type="hidden" name="shopId" value={shopId} />}
      <Input
        label="Service name"
        name="name"
        defaultValue={service?.name ?? ""}
        placeholder="e.g. Men's Haircut"
        required
      />
      <Input
        label="Category (optional)"
        name="category"
        defaultValue={service?.category ?? ""}
        placeholder="e.g. Hair, Nails, Skin"
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Price (£)"
          name="price"
          inputMode="decimal"
          defaultValue={service ? (service.price_pence / 100).toFixed(2) : ""}
          placeholder="0.00"
          required
        />
        <Input
          label="Duration (minutes)"
          name="duration_min"
          type="number"
          inputMode="numeric"
          defaultValue={service?.durationMinutes ?? ""}
          placeholder="30"
          min="1"
          step="1"
          required
        />
      </div>
      {!busy && fetcher.data && !fetcher.data.ok && (
        <p className="text-sm text-red-400" role="alert">{fetcher.data.error}</p>
      )}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Saving…" : submitLabel}
      </Button>
    </fetcher.Form>
  );
}
