import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Plus, Pencil, ToggleLeft, ToggleRight } from "lucide-react";
import { useState, useEffect } from "react";
import type { SessionPayload } from "~/lib/auth";
import { getSessionToken, requireRole } from "~/lib/auth";
import { formatPence, parsePoundsToPence } from "@repo/utils";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

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

type ActionData =
  | { ok: true; intent: string }
  | { error: string };

// ─── Shop ID resolution (matches admin.staff.tsx pattern) ────────────────────

function resolveShopId(
  request: Request,
  user: SessionPayload,
  formShopId: string | null
): string | null {
  const url = new URL(request.url);
  if (user.role === "developer") {
    const fromForm = formShopId?.trim();
    const fromQuery = url.searchParams.get("shopId")?.trim();
    return fromForm || fromQuery || null;
  }
  return user.shop_id?.trim() || null;
}

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = resolveShopId(request, user, null);

  let services: Service[] = [];
  if (shopId) {
    try {
      // Fetch all (active + inactive) — worker returns is_active=1 by default,
      // so we fetch and show toggle. For inactive we call with ?all=1 if worker
      // supports it, otherwise we show what we get and let admin toggle.
      services = await api.get<Service[]>(`/api/shops/${shopId}/services`);
    } catch {
      /* empty */
    }
  }

  return json({
    services,
    shopId,
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
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = resolveShopId(request, user, formShopId);

  if (!shopId) {
    return json<ActionData>(
      { error: "Missing shop. Admins need a linked shop; developers add ?shopId=… to the URL." },
      { status: 400 }
    );
  }

  const api = createApiClient(env.API_URL, token);

  // ── CREATE ──
  if (intent === "create") {
    const name = String(form.get("name") ?? "").trim();
    const category = String(form.get("category") ?? "").trim() || undefined;
    const priceStr = String(form.get("price") ?? "");
    const durationStr = String(form.get("duration_min") ?? "");

    if (!name) return json<ActionData>({ error: "Service name is required." }, { status: 400 });
    const pricePence = parsePoundsToPence(priceStr);
    if (pricePence === null)
      return json<ActionData>({ error: "Valid price required (e.g. 25 or 25.50)." }, { status: 400 });
    if (!durationStr || isNaN(parseInt(durationStr)))
      return json<ActionData>({ error: "Valid duration required." }, { status: 400 });

    try {
      await api.post(`/api/shops/${shopId}/services`, {
        name,
        category,
        price_pence: pricePence,
        duration_min: parseInt(durationStr),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to create service";
      return json<ActionData>({ error: msg }, { status: 400 });
    }

    return json<ActionData>({ ok: true, intent: "create" });
  }

  // ── UPDATE ──
  if (intent === "update") {
    const serviceId = String(form.get("serviceId") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const category = String(form.get("category") ?? "").trim() || null;
    const priceStr = String(form.get("price") ?? "");
    const durationStr = String(form.get("duration_min") ?? "");

    if (!serviceId || !name) return json<ActionData>({ error: "Invalid data." }, { status: 400 });
    const pricePence = parsePoundsToPence(priceStr);
    if (pricePence === null)
      return json<ActionData>({ error: "Valid price required (e.g. 25 or 25.50)." }, { status: 400 });

    try {
      await api.put(`/api/shops/${shopId}/services/${serviceId}`, {
        name,
        category,
        price_pence: pricePence,
        duration_min: parseInt(durationStr),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to update service";
      return json<ActionData>({ error: msg }, { status: 400 });
    }

    return json<ActionData>({ ok: true, intent: "update" });
  }

  // ── DEACTIVATE (soft delete) ──
  if (intent === "deactivate") {
    const serviceId = String(form.get("serviceId") ?? "").trim();
    if (!serviceId) return json<ActionData>({ error: "Missing service ID." }, { status: 400 });
    try {
      await api.del(`/api/shops/${shopId}/services/${serviceId}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to deactivate service";
      return json<ActionData>({ error: msg }, { status: 400 });
    }
    return json<ActionData>({ ok: true, intent: "deactivate" });
  }

  // ── RESTORE ──
  if (intent === "restore") {
    const serviceId = String(form.get("serviceId") ?? "").trim();
    if (!serviceId) return json<ActionData>({ error: "Missing service ID." }, { status: 400 });
    try {
      await api.put(`/api/shops/${shopId}/services/${serviceId}`, { is_active: 1 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to restore service";
      return json<ActionData>({ error: msg }, { status: 400 });
    }
    return json<ActionData>({ ok: true, intent: "restore" });
  }

  return json<ActionData>({ error: "Unknown action." }, { status: 400 });
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
  const { services, shopId, developerNeedsShop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";

  const [addOpen, setAddOpen] = useState(false);
  const [editService, setEditService] = useState<Service | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  // Close dialogs on successful action
  useEffect(() => {
    if (actionData && "ok" in actionData) {
      setAddOpen(false);
      setEditService(null);
    }
  }, [actionData]);

  const active = services.filter((s) => s.isActive);
  const inactive = services.filter((s) => !s.isActive);
  const displayed = showInactive ? services : active;

  // Group by category
  const grouped = displayed.reduce<Record<string, Service[]>>((acc, svc) => {
    const key = svc.category || "Uncategorised";
    if (!acc[key]) acc[key] = [];
    acc[key].push(svc);
    return acc;
  }, {});

  return (
    <div>
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Services</h1>
          <p className="mt-0.5 text-sm text-white/60">
            {active.length} active
            {inactive.length > 0 && ` · ${inactive.length} inactive`}
          </p>
        </div>

        <Dialog open={addOpen} onOpenChange={setAddOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={developerNeedsShop}>
              <Plus className="h-4 w-4" /> Add service
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>New service</DialogTitle>
            </DialogHeader>
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="create" />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <ServiceFields />
              {actionData && "error" in actionData && (
                <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
              )}
              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Save service →"}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Developer hint */}
      {developerNeedsShop && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage services as a developer.
        </div>
      )}

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
            <Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="update" />
              <input type="hidden" name="serviceId" value={editService.id} />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <ServiceFields service={editService} />
              {actionData && "error" in actionData && (
                <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
              )}
              <Button type="submit" variant="outline" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? "Saving…" : "Update service →"}
              </Button>
            </Form>
          )}
        </DialogContent>
      </Dialog>

      {/* Toggle inactive */}
      {inactive.length > 0 && (
        <button
          type="button"
          onClick={() => setShowInactive((v) => !v)}
          className="tap-target mb-4 inline-flex items-center text-xs text-white/60 hover:text-gold transition-colors"
        >
          {showInactive ? "Hide inactive" : `Show ${inactive.length} inactive`}
        </button>
      )}

      {/* Service list */}
      {Object.keys(grouped).length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/20 p-12 text-center text-white/60">
          <p className="text-lg">No services yet.</p>
          <p className="mt-1 text-sm">Add your first service above.</p>
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([category, svcs]) => (
            <div key={category}>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/50">
                {category}
              </h3>
              <div className="space-y-2">
                {svcs.map((svc) => (
                  <ServiceRow
                    key={svc.id}
                    service={svc}
                    shopId={shopId}
                    onEdit={() => setEditService(svc)}
                    isSubmitting={isSubmitting}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── ServiceRow ───────────────────────────────────────────────────────────────

function ServiceRow({
  service,
  shopId,
  onEdit,
  isSubmitting,
}: {
  service: Service;
  shopId: string | null;
  onEdit: () => void;
  isSubmitting: boolean;
}) {
  const inactive = !service.isActive;

  return (
    <div
      className={`flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border p-4 transition-colors ${
        inactive
          ? "border-white/5 bg-white/3 opacity-50"
          : "border-white/10 bg-dark-100 hover:border-white/20"
      }`}
    >
      {/* Info */}
      <div className="min-w-[9rem] flex-1">
        <p className="truncate text-sm font-medium text-white">
          {service.name}
          {inactive && (
            <span className="ml-2 text-xs text-white/50">(inactive)</span>
          )}
        </p>
        {service.category && (
          <p className="mt-0.5 truncate text-xs text-white/60">{service.category}</p>
        )}
      </div>

      {/* Price + duration */}
      <div className="shrink-0 text-right">
        <p className="text-sm font-semibold text-gold">
          {formatPence(service.price_pence)}
        </p>
        <p className="text-xs text-white/60">
          {formatDuration(service.durationMinutes)}
        </p>
      </div>

      {/* Actions */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onEdit}
          className="tap-target flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/60 hover:bg-white/5 hover:text-white transition-colors"
        >
          <Pencil className="h-3 w-3" /> Edit
        </button>

        <Form method="post">
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <input type="hidden" name="serviceId" value={service.id} />
          <input
            type="hidden"
            name="intent"
            value={inactive ? "restore" : "deactivate"}
          />
          <button
            type="submit"
            disabled={isSubmitting}
            className={`tap-target flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs transition-colors disabled:opacity-50 ${
              inactive
                ? "border-green-500/30 text-green-400 hover:bg-green-500/10"
                : "border-red-500/20 text-red-400/80 hover:bg-red-500/10"
            }`}
          >
            {inactive ? (
              <><ToggleRight className="h-3 w-3" /> Restore</>
            ) : (
              <><ToggleLeft className="h-3 w-3" /> Deactivate</>
            )}
          </button>
        </Form>
      </div>
    </div>
  );
}

// ─── ServiceFields ────────────────────────────────────────────────────────────

function ServiceFields({ service }: { service?: Service }) {
  return (
    <>
      <Input
        label="Service name *"
        name="name"
        defaultValue={service?.name ?? ""}
        placeholder="e.g. Men's Haircut"
        required
      />
      <Input
        label="Category"
        name="category"
        defaultValue={service?.category ?? ""}
        placeholder="e.g. Hair, Nails, Skin"
      />
      <div className="grid grid-cols-2 gap-3">
        <Input
          label="Price (£) *"
          name="price"
          type="number"
          defaultValue={service ? (service.price_pence / 100).toFixed(2) : ""}
          placeholder="0.00"
          min="0"
          step="0.01"
          required
        />
        <Input
          label="Duration (mins) *"
          name="duration_min"
          type="number"
          defaultValue={service?.durationMinutes ?? ""}
          placeholder="30"
          min="5"
          step="5"
          required
        />
      </div>
    </>
  );
}
