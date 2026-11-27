import { useLoaderData, useFetcher, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Plus, Mail, Pencil, UserX, Camera, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { pageShopId } from "~/lib/pageShop";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Textarea } from "~/components/ui/Textarea";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { LoadError } from "~/components/ui/LoadError";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/Dialog";
import { assignableServices, isActiveFlag, type AssignableService } from "~/components/admin/staffServices";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export const meta = () => pageTitle("Staff");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/admin" homeLabel="Back to overview" />;
}

// ─── Types ────────────────────────────────────────────────────────────────────

/** A service as it comes nested in a staff row: the raw database shape. */
interface StaffServiceRow {
  id: string;
  name: string;
}

interface Staff {
  id: string;
  display_name: string;
  bio?: string | null;
  speciality?: string | null;
  avatar_url?: string | null;
  /** 0 or 1 from the API. */
  is_active: number | boolean;
  user_email?: string;
  services?: StaffServiceRow[];
}

type ActionData = { ok: true; intent: string; message: string } | { ok: false; intent: string; error: string };

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = pageShopId(request, user, null);

  let staff: Staff[] = [];
  let services: AssignableService[] = [];
  let loadError = false;
  let servicesLoadError = false;

  if (shopId) {
    // Independent fetches: run them together. Deactivated members come too,
    // so the owner can restore one.
    const [staffRes, servicesRes] = await Promise.allSettled([
      api.get<Staff[]>(`/api/shops/${shopId}/staff?include_inactive=1`),
      api.get<unknown>(`/api/shops/${shopId}/services`),
    ]);
    if (staffRes.status === "fulfilled") staff = staffRes.value;
    else loadError = true;
    // The services list is in the public shape (durationMinutes, isActive).
    if (servicesRes.status === "fulfilled") services = assignableServices(servicesRes.value);
    else servicesLoadError = true;
  }

  return json({
    staff,
    services,
    shopId,
    loadError,
    servicesLoadError,
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
  if (!token) return fail("", "You are signed out. Sign in again to continue.", 401);

  const form = await readFormData(request);
  if (!form) return fail("", UNREADABLE_FORM);
  const intent = String(form.get("intent") ?? "");
  const formShopId = String(form.get("shopId") ?? "").trim() || null;
  const shopId = pageShopId(request, user, formShopId);
  if (!shopId) return fail(intent, "Choose a shop first.");

  const api = createApiClient(env.API_URL, token);

  // ── Invite new staff ──
  if (intent === "invite") {
    const name = String(form.get("name") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    if (!name || !email) return fail(intent, "Enter a name and an email address.");
    try {
      await api.post(`/api/shops/${shopId}/staff`, { display_name: name, email });
      return json<ActionData>({ ok: true, intent, message: `Invite sent to ${email}.` });
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The invite could not be sent. Try again.");
    }
  }

  // ── Edit staff ──
  if (intent === "edit") {
    const staffId = String(form.get("staffId") ?? "").trim();
    const displayName = String(form.get("display_name") ?? "").trim();
    const bio = String(form.get("bio") ?? "").trim() || null;
    const speciality = String(form.get("speciality") ?? "").trim() || null;
    // The field is only sent when the services list loaded. Present and empty
    // means "no services": every box was unticked.
    const serviceIds = form.has("service_ids")
      ? String(form.get("service_ids") ?? "").split(",").filter(Boolean)
      : undefined;
    if (!staffId || !displayName) return fail(intent, "Enter a name for this staff member.");
    try {
      await api.put(`/api/shops/${shopId}/staff/${staffId}`, {
        display_name: displayName,
        bio,
        speciality,
        ...(serviceIds !== undefined && { service_ids: serviceIds }),
      });
      return json<ActionData>({ ok: true, intent, message: `${displayName} saved.` });
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The changes could not be saved. Try again.");
    }
  }

  // ── Deactivate staff ──
  if (intent === "deactivate") {
    const staffId = String(form.get("staffId") ?? "").trim();
    if (!staffId) return fail(intent, "That staff member could not be found. Reload the page and try again.");
    try {
      await api.del(`/api/shops/${shopId}/staff/${staffId}`);
      return json<ActionData>({ ok: true, intent, message: "Staff member deactivated. Restore them from the inactive list." });
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The staff member could not be deactivated. Try again.");
    }
  }

  // ── Restore staff ──
  if (intent === "restore") {
    const staffId = String(form.get("staffId") ?? "").trim();
    if (!staffId) return fail(intent, "That staff member could not be found. Reload the page and try again.");
    try {
      await api.put(`/api/shops/${shopId}/staff/${staffId}`, { is_active: 1 });
      return json<ActionData>({ ok: true, intent, message: "Staff member restored." });
    } catch (e) {
      return fail(intent, e instanceof Error ? e.message : "The staff member could not be restored. Try again.");
    }
  }

  return fail(intent, "That action is not recognised. Reload the page and try again.");
}

// ─── Edit Modal ───────────────────────────────────────────────────────────────

function EditStaffModal({
  member,
  shopId,
  allServices,
  servicesLoadError,
  onClose,
  onSaved,
}: {
  member: Staff;
  shopId: string;
  allServices: AssignableService[];
  servicesLoadError: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const [selectedServices, setSelectedServices] = useState<Set<string>>(
    new Set((member.services ?? []).map((s) => s.id))
  );

  useFetcherResult(fetcher, (data) => {
    if (data.ok) onSaved(data.message);
  });

  function toggleService(id: string) {
    setSelectedServices((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const busy = fetcher.state !== "idle";

  return (
    <fetcher.Form method="post" className="space-y-5">
      <input type="hidden" name="intent" value="edit" />
      <input type="hidden" name="shopId" value={shopId} />
      <input type="hidden" name="staffId" value={member.id} />
      {/* Not sent when the list failed to load, so a blank list never wipes assignments. */}
      {!servicesLoadError && (
        <input type="hidden" name="service_ids" value={Array.from(selectedServices).join(",")} />
      )}

      <Input label="Name" name="display_name" defaultValue={member.display_name} required />

      <div>
        <Input
          label="Speciality (optional)"
          name="speciality"
          defaultValue={member.speciality ?? ""}
          maxLength={80}
          placeholder="e.g. Skin fades and beard work"
        />
        <p className="mt-1.5 text-xs text-white/60">Shown under their name on your site and in booking, and used when your site is generated.</p>
      </div>

      <Textarea
        label="Bio (optional)"
        name="bio"
        defaultValue={member.bio ?? ""}
        rows={3}
        placeholder="Short bio visible to customers…"
      />

      {servicesLoadError ? (
        <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          We couldn&apos;t load your services, so assigned services can&apos;t be changed right now. Other changes will
          still save. Reload the page to try again.
        </p>
      ) : allServices.length === 0 ? (
        <p className="text-sm text-white/60">
          You have no active services yet. Add services first, then assign them here.
        </p>
      ) : (
        <fieldset>
          <legend className="mb-2 block text-sm font-medium text-white/80">Assigned services</legend>
          <div className="max-h-48 space-y-1 overflow-y-auto pr-1">
            {allServices.map((svc) => (
              <label key={svc.id} className="tap-target group flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={selectedServices.has(svc.id)}
                  onChange={() => toggleService(svc.id)}
                />
                <div
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border transition-all peer-focus-visible:ring-2 peer-focus-visible:ring-gold/60 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-dark ${
                    selectedServices.has(svc.id)
                      ? "border-gold bg-gold"
                      : "border-white/40 bg-white/5 group-hover:border-white/60"
                  }`}
                >
                  {selectedServices.has(svc.id) && (
                    <svg className="h-3 w-3 text-dark" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <span className="text-sm text-white">{svc.name}</span>
                  <span className="ml-2 text-xs text-white/60">
                    {svc.durationMinutes} min · {formatPence(svc.price_pence)}
                  </span>
                </div>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      {!busy && fetcher.data && !fetcher.data.ok && (
        <p role="alert" className="text-sm text-red-400">{fetcher.data.error}</p>
      )}

      <div className="flex gap-3 pt-1">
        <Button type="button" variant="ghost" className="flex-1" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button type="submit" className="flex-1" disabled={busy}>
          {busy ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </fetcher.Form>
  );
}

// ─── Invite dialog ────────────────────────────────────────────────────────────

function InviteDialog({
  shopId,
  disabled,
  onInvited,
}: {
  shopId: string | null;
  disabled: boolean;
  onInvited: (message: string) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const [open, setOpen] = useState(false);
  // An error belongs to the attempt that produced it: reopening starts clean.
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.ok) {
      setError(null);
      setOpen(false);
      onInvited(data.message);
    } else {
      // The dialog stays open with what was typed, and says why.
      setError(data.error);
    }
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setOpen(next);
        if (next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <Plus className="h-4 w-4" aria-hidden /> Add staff
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Invite staff member</DialogTitle></DialogHeader>
        <fetcher.Form method="post" className="space-y-4" onSubmit={() => setError(null)}>
          <input type="hidden" name="intent" value="invite" />
          {shopId && <input type="hidden" name="shopId" value={shopId} />}
          <Input label="Name" name="name" required autoComplete="off" />
          <Input label="Email" name="email" type="email" required autoComplete="off" />
          <p className="text-xs text-white/60">We email them a link to set up their own sign in.</p>
          {error && !busy && (
            <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={busy}>
            <Mail className="h-4 w-4" aria-hidden />
            {busy ? "Sending invite…" : "Send invite"}
          </Button>
        </fetcher.Form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Avatar Upload ────────────────────────────────────────────────────────────

function AvatarUpload({
  member,
  shopId,
  onError,
}: {
  member: Staff;
  shopId: string;
  onError: (message: string | null) => void;
}) {
  const fetcher = useFetcher<{ success: boolean; avatarUrl?: string; error?: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  /** The photo the server holds. The picked file is only shown while it uploads. */
  const [saved, setSaved] = useState<string | null>(member.avatar_url ?? null);
  const [pending, setPending] = useState<string | null>(null);
  const isUploading = fetcher.state !== "idle";

  // The picked file's local preview is released once it is no longer shown.
  useEffect(() => {
    if (!pending) return;
    return () => URL.revokeObjectURL(pending);
  }, [pending]);

  useFetcherResult(fetcher, (data) => {
    // Either way the local preview goes: the saved photo, old or new, is what is true.
    setPending(null);
    if (data.success && data.avatarUrl) {
      setSaved(data.avatarUrl);
      onError(null);
    } else {
      onError(data.error ?? "The photo could not be uploaded. Try a JPEG, PNG or WebP under 5 MB.");
    }
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Allow picking the same file again after a failure.
    e.target.value = "";
    if (!file) return;
    onError(null);
    setPending(URL.createObjectURL(file));
    const form = new FormData();
    form.append("file", file);
    fetcher.submit(form, {
      method: "post",
      action: `/api/staff/${shopId}/${member.id}/avatar`,
      encType: "multipart/form-data",
    });
  }

  const preview = pending ?? saved;

  return (
    <div className="group relative h-12 w-12 shrink-0">
      {preview ? (
        <img src={preview} alt="" className="h-12 w-12 rounded-full border border-white/10 object-cover" />
      ) : (
        <div aria-hidden className="flex h-12 w-12 items-center justify-center rounded-full bg-gold/20 font-heading text-lg font-bold text-gold">
          {member.display_name.charAt(0).toUpperCase()}
        </div>
      )}
      {/* Upload overlay */}
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={isUploading}
        aria-label={isUploading ? `Uploading photo for ${member.display_name}` : `Upload a photo for ${member.display_name}`}
        className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 opacity-0 transition-opacity focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold group-hover:opacity-100 [@media(pointer:coarse)]:bg-black/35 [@media(pointer:coarse)]:opacity-100"
      >
        {isUploading
          ? <div aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          : <Camera className="h-4 w-4 text-white" aria-hidden />}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        tabIndex={-1}
        aria-hidden
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
  servicesLoadError,
  onNotice,
}: {
  member: Staff;
  shopId: string;
  allServices: AssignableService[];
  servicesLoadError: boolean;
  onNotice: (message: string) => void;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deactivateError, setDeactivateError] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const deactivateFetcher = useFetcher<ActionData>();

  const isDeactivating = deactivateFetcher.state !== "idle";
  const assignedCount = (member.services ?? []).length;

  useFetcherResult(deactivateFetcher, (data) => {
    if (data.ok) {
      setConfirmOpen(false);
      onNotice(`${member.display_name} deactivated. Restore them from the inactive list.`);
    } else {
      setDeactivateError(data.error);
    }
  });

  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
      {/* Avatar + name row */}
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <AvatarUpload member={member} shopId={shopId} onError={setAvatarError} />
          <div className="min-w-0">
            <p className="truncate font-semibold text-white">{member.display_name}</p>
            {member.user_email && (
              <p className="mt-0.5 truncate text-xs text-white/60">{member.user_email}</p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-1">
          <Dialog open={editOpen} onOpenChange={setEditOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`Edit ${member.display_name}`} className="text-white/60 hover:text-white">
                <Pencil className="h-4 w-4" aria-hidden />
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Edit {member.display_name}</DialogTitle>
              </DialogHeader>
              <EditStaffModal
                member={member}
                shopId={shopId}
                allServices={allServices}
                servicesLoadError={servicesLoadError}
                onClose={() => setEditOpen(false)}
                onSaved={(message) => {
                  setEditOpen(false);
                  onNotice(message);
                }}
              />
            </DialogContent>
          </Dialog>

          <Button
            variant="ghost"
            size="icon"
            aria-label={`Deactivate ${member.display_name}`}
            className="text-white/60 hover:bg-red-500/10 hover:text-red-400"
            onClick={() => {
              setDeactivateError(null);
              setConfirmOpen(true);
            }}
          >
            <UserX className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      </div>

      {avatarError && (
        <p role="alert" className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          Photo not saved: {avatarError}
        </p>
      )}

      {/* Bio */}
      {member.bio && (
        <p className="mb-3 line-clamp-2 text-sm text-white/60">{member.bio}</p>
      )}

      {/* Assigned services */}
      <div className="flex flex-wrap gap-1">
        {(member.services ?? []).slice(0, 3).map((svc) => (
          <span key={svc.id} className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs text-white/70">
            {svc.name}
          </span>
        ))}
        {assignedCount > 3 && (
          <span className="rounded-full bg-white/5 px-2 py-0.5 text-xs text-white/60">
            +{assignedCount - 3} more
          </span>
        )}
        {assignedCount === 0 && (
          <span className="text-xs text-white/60">No services assigned, so customers cannot book them yet.</span>
        )}
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          setDeactivateError(null);
          deactivateFetcher.submit(
            { intent: "deactivate", shopId, staffId: member.id },
            { method: "post" },
          );
        }}
        title={`Deactivate ${member.display_name}?`}
        confirmLabel={`Deactivate ${member.display_name}`}
        destructive
        pending={isDeactivating}
        pendingLabel="Deactivating…"
        error={deactivateError}
      >
        <p>
          They come off your team list and your booking page. Bookings already made are not changed, so move or
          cancel those yourself if needed.
        </p>
        <p>This can be undone: restore them from the inactive list on this page.</p>
      </ConfirmDialog>
    </div>
  );
}

// ─── Inactive row ─────────────────────────────────────────────────────────────

function InactiveStaffRow({
  member,
  shopId,
  onNotice,
}: {
  member: Staff;
  shopId: string;
  onNotice: (message: string) => void;
}) {
  const fetcher = useFetcher<ActionData>();
  const [error, setError] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";

  useFetcherResult(fetcher, (data) => {
    if (data.ok) onNotice(`${member.display_name} restored.`);
    else setError(data.error);
  });

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-[9rem] flex-1">
        <p className="truncate text-sm font-medium text-white/80">{member.display_name}</p>
        {member.user_email && <p className="truncate text-xs text-white/60">{member.user_email}</p>}
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={busy}
        onClick={() => {
          setError(null);
          fetcher.submit({ intent: "restore", shopId, staffId: member.id }, { method: "post" });
        }}
      >
        <RotateCcw className="h-3.5 w-3.5" aria-hidden />
        {busy ? "Restoring…" : "Restore"}
      </Button>
      {error && !busy && (
        <p role="alert" className="w-full text-xs text-red-400">{error}</p>
      )}
    </li>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function AdminStaff() {
  const { staff, services, shopId, loadError, servicesLoadError, developerNeedsShop } =
    useLoaderData<typeof loader>();
  const [notice, setNotice] = useState<string | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const active = staff.filter((m) => isActiveFlag(m.is_active));
  const inactive = staff.filter((m) => !isActiveFlag(m.is_active));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-bold text-white">Staff</h1>
          {!loadError && (
            <p className="mt-0.5 text-sm text-white/60">
              {active.length} active member{active.length !== 1 ? "s" : ""}
              {inactive.length > 0 && ` · ${inactive.length} inactive`}
            </p>
          )}
        </div>
        <InviteDialog shopId={shopId} disabled={developerNeedsShop} onInvited={setNotice} />
      </div>

      {/* The outcome of the last action. Always mounted, so a screen reader hears it arrive. */}
      <div role="status" className={notice ? "rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-100" : "sr-only"}>
        {notice}
      </div>

      {/* Developer warning */}
      {developerNeedsShop && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to manage staff as a developer.
        </div>
      )}

      {/* Staff grid */}
      {loadError ? (
        <LoadError what="your staff" />
      ) : active.length === 0 ? (
        <div className="rounded-xl border border-dashed border-white/10 p-12 text-center">
          <p className="text-sm font-medium text-white/80">
            {inactive.length > 0 ? "No active staff members" : "No staff members yet"}
          </p>
          <p className="mt-1 text-xs text-white/60">
            {inactive.length > 0
              ? "Restore someone from the inactive list below, or add a new team member."
              : "Use Add staff to invite your first team member."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {active.map((member) => (
            <StaffCard
              key={member.id}
              member={member}
              shopId={shopId!}
              allServices={services}
              servicesLoadError={servicesLoadError}
              onNotice={setNotice}
            />
          ))}
        </div>
      )}

      {/* Inactive members, collapsed until asked for */}
      {!loadError && inactive.length > 0 && shopId && (
        <section>
          <button
            type="button"
            aria-expanded={showInactive}
            onClick={() => setShowInactive((v) => !v)}
            className="tap-target inline-flex items-center rounded-lg text-sm text-white/70 underline-offset-4 transition-colors hover:text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
          >
            {showInactive ? "Hide inactive" : `Show ${inactive.length} inactive`}
          </button>
          {showInactive && (
            <ul className="mt-2 divide-y divide-white/5 rounded-xl border border-white/10 bg-dark-100">
              {inactive.map((member) => (
                <InactiveStaffRow key={member.id} member={member} shopId={shopId} onNotice={setNotice} />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
