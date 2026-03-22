import { Form, useLoaderData, useNavigation } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { Plus, Mail } from "lucide-react";
import { useState } from "react";
import { getSessionToken } from "~/lib/auth";
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

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);
  let staff: Staff[] = [];
  try { staff = await api.get("/api/admin/staff"); } catch { /* empty */ }
  return json({ staff });
}

export default function AdminStaff() {
  const { staff } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const [open, setOpen] = useState(false);

  return (
    <div>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-heading text-2xl font-bold text-white">Staff</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm"><Plus className="h-4 w-4" /> Add staff</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add staff member</DialogTitle></DialogHeader>
            <Form method="post" className="space-y-4" onSubmit={() => setOpen(false)}>
              <Input label="Name" name="name" required />
              <Input label="Email" name="email" type="email" required />
              <Button type="submit" className="w-full" disabled={nav.state === "submitting"}>
                {nav.state === "submitting" ? "Sending invite…" : "Send invite →"}
              </Button>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

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
                <button className="flex items-center gap-1 text-xs text-white/40 hover:text-gold">
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
