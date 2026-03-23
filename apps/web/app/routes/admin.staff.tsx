import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Plus, Mail } from "lucide-react";
import { useEffect, useState } from "react";
import type { SessionPayload } from "~/lib/auth";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "~/components/ui/Dialog";

interface Staff {
  id: string;
  display_name: string;
  bio?: string;
  is_active: boolean;
}

/** Admin: JWT shop_id. Developer: URL `?shopId=` or form `shopId` (path must be a real shop). */
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

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  const shopId = resolveShopId(request, user, null);

  let staff: Staff[] = [];
  if (shopId) {
    try {
      staff = await api.get<Staff[]>(`/api/shops/${shopId}/staff`);
    } catch {
      /* empty */
    }
  }

  return json({
    staff,
    shopId,
    developerNeedsShop: user.role === "developer" && !shopId,
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const user = await requireRole(request, "admin", env.API_URL);
  const token = getSessionToken(request);
  if (!token) {
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const email = String(form.get("email") ?? "").trim();
  const formShopId = String(form.get("shopId") ?? "").trim() || null;

  const shopId = resolveShopId(request, user, formShopId);
  if (!shopId) {
    return json({ error: "Missing shop. Admins need a linked shop; developers add ?shopId=… to the URL." }, { status: 400 });
  }
  if (!name || !email) {
    return json({ error: "Name and email are required" }, { status: 400 });
  }

  const api = createApiClient(env.API_URL, token);
  try {
    await api.post(`/api/shops/${shopId}/staff`, { display_name: name, email });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create staff";
    return json({ error: msg }, { status: 400 });
  }

  return json({ ok: true });
}

export default function AdminStaff() {
  const { staff, shopId, developerNeedsShop } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (actionData && "ok" in actionData && actionData.ok) setOpen(false);
  }, [actionData]);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold text-white">Staff</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={developerNeedsShop}>
              <Plus className="h-4 w-4" /> Add staff
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add staff member</DialogTitle></DialogHeader>
            <Form method="post" className="space-y-4">
              {shopId ? <input type="hidden" name="shopId" value={shopId} /> : null}
              <Input label="Name" name="name" required />
              <Input label="Email" name="email" type="email" required />
              {actionData && "error" in actionData && actionData.error ? (
                <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
              ) : null}
              <Button type="submit" className="w-full" disabled={nav.state === "submitting"}>
                {nav.state === "submitting" ? "Sending invite…" : "Send invite →"}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      {developerNeedsShop ? (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
          Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> (a real shop UUID) to manage staff as a developer.
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {staff.length === 0 ? (
          <div className="col-span-full rounded-xl border border-dashed border-white/20 p-8 text-center text-white/40">
            No staff members yet. Add your first team member above.
          </div>
        ) : (
          staff.map((s) => (
            <div key={s.id} className="rounded-xl border border-white/10 bg-dark-100 p-5">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-gold/20 font-heading text-lg font-bold text-gold">
                {s.display_name.charAt(0).toUpperCase()}
              </div>
              <p className="font-medium text-white">{s.display_name}</p>
              {s.bio && <p className="mt-1 text-sm text-white/60">{s.bio}</p>}
              <div className="mt-3 flex items-center gap-2">
                <button type="button" className="flex items-center gap-1 text-xs text-white/40 hover:text-gold">
                  <Mail className="h-3.5 w-3.5" /> Invite
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
