import { useLoaderData, useActionData, useNavigation, useFetcher } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Plus, Mail, Pencil, UserX, Camera } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SessionPayload } from "~/lib/auth";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/Dialog";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Service {
  id: string;
  name: string;
  duration_min: number;
  price_pence: number;
  is_active: boolean;
}

interface Staff {
  id: string;
  display_name: string;
  bio?: string | null;
  avatar_url?: string | null;
  is_active: boolean;
  user_email?: string;
  services?: Service[];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveShopId(request: Request, user: SessionPayload, formShopId: string | null): string | null {
  if (user.role === "developer") {
    const fromForm = formShopId?.trim();
    const fromQuery = new URL(request.url).searchParams.get("shopId")?.trim();
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

  let staff: Staff[] = [];
  let services: Service[] = [];

  if (shopId) {
    // Independent fetches — run them concurrently instead of serially.
    const [staffRes, servicesRes] = await Promise.allSettled([
      api.get<Staff[]>(`/api/shops/${shopId}/staff`),
      api.get<Service[]>(`/api/shops/${shopId}/services`),
    ]);
    if (staffRes.status === "fulfilled") staff = staffRes.value;
    if (servicesRes.status === "fulfilled") services = servicesRes.value;
  }

  return json({ staff, services, shopId, developerNeedsShop: user.role === "developer" && !shopId });
}

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) return json({ error: "Unauthorized" }, { status: 401 });

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = resolveShopId(request, user, formShopId);
  if (!shopId) return json({ error: "Missing shop ID" }, { status: 400 });

  const api = createApiClient(env.API_URL, token);

  // ── Invite new staff ──
  if (intent === "invite") {
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    if (!name || !email) return json({ error: "Name and email are required" }, { status: 400 });
    try {
      await api.post(`/api/shops/${shopId}/staff`, { display_name: name, email });
      return json({ ok: true, intent: "invite" });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to invite staff" }, { status: 400 });
    }
  }

  // ── Edit staff ──
  if (intent === "edit") {
    const staffId = String(form.get("staffId") ?? "").trim();
    const displayName = String(form.get("display_name") ?? "").trim();
    const bio = String(form.get("bio") ?? "").trim() || null;
    const serviceIdsRaw = form.get("service_ids");
    const serviceIds = serviceIdsRaw ? String(serviceIdsRaw).split(",").filter(Boolean) : undefined;
    if (!staffId || !displayName) return json({ error: "Staff ID and name required" }, { status: 400 });
    try {
      await api.put(`/api/shops/${shopId}/staff/${staffId}`, {
        display_name: displayName,
        bio,
        ...(serviceIds !== undefined && { service_ids: serviceIds }),
      });
      return json({ ok: true, intent: "edit" });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to update staff" }, { status: 400 });
    }
  }

  // ── Deactivate staff ──
  if (intent === "deactivate") {
    const staffId = String(form.get("staffId") ?? "").trim();
    if (!staffId) return json({ error: "Staff ID required" }, { status: 400 });
    try {
      await api.del(`/api/shops/${shopId}/staff/${staffId}`);
      return json({ ok: true, intent: "deactivate" });
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to deactivate staff" }, { status: 400 });
    }
  }

  return json({ error: "Unknown intent" }, { status: 400 });
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditStaffModal({
  member,
  shopId,
  allServices,
  onClose,
}: {
  member: Staff;
  shopId: string;
  allServices: Service[];
  onClose: () => void;
}) {
  const fetcher = useFetcher<typeof action>();
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set((member.services ?? []).map((s) => s.id))
  );

  useEffect(() => {
    if (fetcher.data && "ok" in fetcher.data && fetcher.data.ok) onClose();
  }, [fetcher.data, onClose]);

  function toggleService(id: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const activeServices = allServices.filter((s) => s.is_active);

  return (
    <fetcher.Form method="post" className="space-y-5">
      <input type="hidden" name="intent" value="edit" />
      <input type="hidden" name="shopId" value={shopId} />
      <input type="hidden" name="staffId" value={member.id} />
      <input type="hidden" name="service_ids" value={Array.from(selectedServices).join(",")} />

      <Input label="Name" name="display_name" defaultValue={member.display_name} required />

      <div>
        <label className="block text-sm font-medium text-white/80 mb-1.5">Bio (optional)</label>
        <textarea
          name="bio"
          defaultValue={member.bio ?? ""}
          rows={3}
          className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold resize-none"
          placeholder="Short bio visible to customers…"
        />
      </div>

      {activeServices.length > 0 && (
        <div>
          <label className="block text-sm font-medium text-white/80 mb-2">Assigned services</label>
          <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
            {activeServices.map((svc) => (
              <label key={svc.id} className="tap-target flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={selectedServices.has(svc.id)}
                  onChange={() => toggleService(svc.id)}
                  aria-label={svc.name}
                />
                <div
                  aria-hidden="true"
                  className={`w-5 h-5 rounded flex items-center justify-center border transition-all shrink-0 peer-focus-visible:ring-2 peer-focus-visible:ring-gold/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-dark ${
                    selectedServices.has(svc.id)
                      ? "bg-gold border-gold"
                      : "border-white/20 bg-white/5 group-hover:border-white/40"
                  }`}
                >
                  {selectedServices.has(svc.id) && (
                    <svg className="w-3 h-3 text-dark" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-white">{svc.name}</span>
                  <span className="text-xs text-white/60 ml-2">{svc.duration_min}min · {formatPence(svc.price_pence)}</span>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {fetcher.data && "error" in fetcher.data && (
        <p className="text-sm text-red-400">{fetcher.data.error}</p>
      )}

      <div className="flex gap-3 pt-1">
        <Button type="button" variant="ghost" className="flex-1" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="flex-1" disabled={fetcher.state === "submitting"}>
          {fetcher.state === "submitting" ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </fetcher.Form>
  );
}


// ─── Avatar Upload ────────────────────────────────────────────────────────────

function AvatarUpload({ member, shopId }: { member: Staff; shopId: string }) {
  const fetcher = useFetcher<{ success: boolean; avatarUrl?: string; error?: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(member.avatar_url ?? null);
  const isUploading = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data.avatarUrl) {
      setPreview(fetcher.data.avatarUrl);
    }
  }, [fetcher.data]);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Local preview
    const url = URL.createObjectURL(file);
    setPreview(url);
    // Upload
    const form = new FormData();
    form.append("file", file);
    fetcher.submit(form, {
      method: "post",
      action: `/api/staff/${shopId}/${member.id}/avatar`,
      encType: "multipart/form-data",
    });
  }

  return (
    <div className="relative w-12 h-12 shrink-0 group">
      {preview ? (
        <img src={preview} alt={member.display_name}
          className="w-12 h-12 rounded-full object-cover border border-white/10" />
      ) : (
        <div className="w-12 h-12 rounded-full bg-gold/20 flex items-center justify-center font-heading text-lg font-bold text-gold">
          {member.display_name.charAt(0).toUpperCase()}
        </div>
      )}
      {/* Upload overlay */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity [@media(pointer:coarse)]:bg-black/35 [@media(pointer:coarse)]:opacity-100"
        title="Upload photo"
      >
        {isUploading
          ? <div className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />
          : <Camera className="w-4 h-4 text-white" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}

// ─── Staff Card ───────────────────────────────────────────────────────────────

function StaffCard({
  member,
  shopId,
  allServices,
}: {
  member: Staff;
  shopId: string;
  allServices: Service[];
}) {
  const [editOpen, setEditOpen] = useState(false);
  const deactivateFetcher = useFetcher<typeof action>();

  const isDeactivating = deactivateFetcher.state !== "idle";
  const assignedCount = (member.services ?? []).length;

  return (
    <div className={`rounded-xl border bg-dark-100 p-5 transition-opacity ${isDeactivating ? "opacity-50" : ""} ${member.is_active ? "border-white/10" : "border-white/5 opacity-60"}`}>
      {/* Avatar + name row */}
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-3">
          <AvatarUpload member={member} shopId={shopId} />
          <div>
            <p className="font-semibold text-white">{member.display_name}</p>
            {member.user_email && (
              <p className="text-xs text-white/60 mt-0.5">{member.user_email}</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 shrink-0">
          {/* Edit */}
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <button aria-label="Edit" className="tap-target w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/40 hover:text-white transition-colors">
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit {member.display_name}</DialogTitle>
              </DialogHeader>
              <EditStaffModal
                member={member}
                shopId={shopId}
                allServices={allServices}
                onClose={() => setEditOpen(false)}
              />
            </DialogContent>
          </Dialog>

          {/* Deactivate */}
          <deactivateFetcher.Form method="post">
            <input type="hidden" name="intent" value="deactivate" />
            <input type="hidden" name="shopId" value={shopId} />
            <input type="hidden" name="staffId" value={member.id} />
            <button
              type="submit"
              disabled={isDeactivating}
              onClick={(e) => { if (!confirm(`Deactivate ${member.display_name}?`)) e.preventDefault(); }}
              className="tap-target w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-500/10 text-white/40 hover:text-red-400 transition-colors"
              title="Deactivate"
            >
              <UserX className="w-3.5 h-3.5" />
            </button>
          </deactivateFetcher.Form>
        </div>
      </div>

      {/* Bio */}
      {member.bio && (
        <p className="text-sm text-white/50 mb-3 line-clamp-2">{member.bio}</p>
      )}

      {/* Assigned services */}
      <div className="flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {(member.services ?? []).slice(0, 3).map((svc) => (
            <span key={svc.id} className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/50 border border-white/10">
              {svc.name}
            </span>
          ))}
          {assignedCount > 3 && (
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/5 text-white/60">
              +{assignedCount - 3} more
            </span>
          )}
          {assignedCount === 0 && (
            <span className="text-xs text-white/60 italic">No services assigned</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminStaff() {
  const { staff, services, shopId, developerNeedsShop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const [inviteOpen, setInviteOpen] = useState(false);

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok && actionData.intent === "invite") {
      setInviteOpen(false);
    }
  }, [actionData]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Staff</h1>
          <p className="mt-0.5 text-sm text-white/60">
            {staff.length} active member{staff.length !== 1 ? "s" : ""}
          </p>
        </div>

        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={developerNeedsShop}>
              <Plus className="h-4 w-4" /> Add staff
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Invite staff member</DialogTitle></DialogHeader>
            <form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="invite" />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <Input label="Name" name="name" required />
              <Input label="Email" name="email" type="email" required />
              {actionData && "error" in actionData && (
                <p className="text-sm text-red-400">{actionData.error}</p>
              )}
              <Button type="submit" className="w-full" disabled={nav.state === "submitting"}>
                <Mail className="w-4 h-4" />
                {nav.state === "submitting" ? "Sending…" : "Send invite"}
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Developer warning */}
      {developerNeedsShop && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage staff as a developer.
        </div>
      )}

      {/* Staff grid */}
      {staff.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-12 text-center text-white/50">
          <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-3">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <p className="text-sm font-medium">No staff members yet</p>
          <p className="text-xs mt-1 text-white/60">Add your first team member above</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {staff.map((member) => (
            <StaffCard
              key={member.id}
              member={member}
              shopId={shopId!}
              allServices={services}
            />
          ))}
        </div>
      )}
    </div>
  );
}
