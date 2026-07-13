import {
  Form,
  Link,
  useActionData,
  useFetcher,
  useNavigate,
  useNavigation,
  useOutletContext,
} from "@remix-run/react";
import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Loader2, Sparkles, Trash2, UserCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";
import type { DevGenerationPrefs, DevShopDetail, DevShopOwnerDetails } from "./dev.shops.$shopId";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId!;
  const form = await request.formData();
  if (form.get("_action") !== "regenerate-site") {
    return json({ ok: false, error: "Unknown action" }, 400);
  }

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  let prefs: DevGenerationPrefs;
  try {
    prefs = await api.get<DevGenerationPrefs>(`/api/shops/${shopId}/generation-prefs`);
  } catch {
    prefs = {
      template: "minimal",
      design_notes: null,
      color_primary: null,
      color_accent: null,
    };
  }

  const body: Record<string, unknown> = {
    template: prefs.template?.trim() || "minimal",
  };
  if (prefs.design_notes?.trim()) body.design_notes = prefs.design_notes.trim();
  if (prefs.color_primary?.trim()) body.color_primary = prefs.color_primary.trim();
  if (prefs.color_accent?.trim()) body.color_accent = prefs.color_accent.trim();

  try {
    const result = await api.post<{ jobId: string }>(`/api/shops/${shopId}/generate-site`, body);
    return redirect(`/dev/shops/${shopId}/generation/${result.jobId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Site generation failed";
    return json({ ok: false, error: msg }, 400);
  }
}

export default function DevShopDetailIndex() {
  const { shop, generationPrefs, ownerDetails } = useOutletContext<{
    shop: DevShopDetail;
    generationPrefs: DevGenerationPrefs;
    ownerDetails: DevShopOwnerDetails | null;
  }>();
  const navigation = useNavigation();
  const actionData = useActionData<{ ok?: boolean; error?: string }>();
  const deleteShopFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const navigate = useNavigate();
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const busy =
    navigation.state !== "idle" &&
    navigation.formData?.get("_action") === "regenerate-site";

  useEffect(() => {
    if (deleteShopFetcher.state !== "idle" || !deleteShopFetcher.data?.success) return;
    setDeleteDialogOpen(false);
    navigate("/dev/shops");
  }, [deleteShopFetcher.state, deleteShopFetcher.data, navigate]);

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex flex-wrap gap-2">
        <Dialog open={ownerDialogOpen} onOpenChange={setOwnerDialogOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="secondary" size="sm">
              <UserCircle className="mr-2 h-4 w-4" />
              Shop owner details
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Shop owner &amp; platform users</DialogTitle>
            </DialogHeader>
            {ownerDetails ? (
              <div className="space-y-4 text-sm">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <dl className="space-y-2">
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Owner name</dt>
                      <dd className="text-white">{ownerDetails.owner_name?.trim() || "—"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Owner email</dt>
                      <dd className="break-all text-white">{ownerDetails.owner_email?.trim() || "—"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Shop phone</dt>
                      <dd className="text-white">{ownerDetails.phone?.trim() || "—"}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/60">
                    Platform users
                  </h3>
                  {ownerDetails.platform_users.length === 0 ? (
                    <p className="text-white/50">No linked platform users yet.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-white/10">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-white/10 bg-white/[0.03]">
                            <th className="px-3 py-2 font-medium text-white/50">Role</th>
                            <th className="px-3 py-2 font-medium text-white/50">Name</th>
                            <th className="px-3 py-2 font-medium text-white/50">Email</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {ownerDetails.platform_users.map((u) => (
                            <tr key={u.id}>
                              <td className="px-3 py-2 capitalize text-white/90">{u.role}</td>
                              <td className="px-3 py-2 text-white/80">{u.name ?? "—"}</td>
                              <td className="px-3 py-2 break-all text-white/70">{u.email}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-white/55">Could not load owner details. Refresh the page or try again.</p>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {actionData?.error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {actionData.error}
        </div>
      )}
      <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Saved generation inputs</h2>
        <p className="mt-1 text-sm text-white/50">
          Regenerate uses these values from the active <code className="text-white/70">shop_sites</code> row (owner
          colours and design notes when set).
        </p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/60">Template</dt>
            <dd className="text-white">{generationPrefs.template}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/60">Primary</dt>
            <dd className="text-white">{generationPrefs.color_primary ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/60">Accent</dt>
            <dd className="text-white">{generationPrefs.color_accent ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/60 align-top">Design notes</dt>
            <dd className="whitespace-pre-wrap text-white/80">
              {generationPrefs.design_notes?.trim() ? generationPrefs.design_notes : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-gold/30 bg-gold/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Regenerate site</h2>
        <p className="mt-1 text-sm text-white/50">
          Queues a new full site generation run with the saved inputs above (same as{" "}
          <code className="text-white/70">POST /api/shops/:shopId/generate-site</code>).
        </p>
        <Form method="post" className="mt-4">
          <input type="hidden" name="_action" value="regenerate-site" />
          <Button type="submit" disabled={busy} className="min-h-12">
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Regenerate site
              </>
            )}
          </Button>
        </Form>
      </section>

      <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-red-200/90">Danger zone</h2>
        <p className="mt-1 text-sm text-white/60">
          Permanently delete this shop and related records. This cannot be undone.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-4 text-red-400 hover:bg-red-500/10 hover:text-red-300"
          onClick={() => setDeleteDialogOpen(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete shop…
        </Button>
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this shop?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-white/65">
              This will remove <span className="font-medium text-white">{shop.name}</span> ({shop.slug}) and related
              data. Confirm to proceed.
            </p>
            {deleteShopFetcher.data &&
            typeof deleteShopFetcher.data === "object" &&
            "error" in deleteShopFetcher.data &&
            typeof (deleteShopFetcher.data as { error?: string }).error === "string" ? (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {(deleteShopFetcher.data as { error: string }).error}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteDialogOpen(false)}>
                Cancel
              </Button>
              <deleteShopFetcher.Form method="post" action={`/api/shops/${shop.id}/delete`}>
                <Button
                  type="submit"
                  size="sm"
                  className="bg-red-600 hover:bg-red-500"
                  disabled={deleteShopFetcher.state !== "idle"}
                >
                  {deleteShopFetcher.state !== "idle" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Deleting…
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete permanently
                    </>
                  )}
                </Button>
              </deleteShopFetcher.Form>
            </div>
          </DialogContent>
        </Dialog>
      </section>

      <p className="text-sm text-white/60">
        <Link to="/dev/shops" className="text-gold hover:underline">
          Back to shops list
        </Link>
        {" · "}
        <a
          href={`https://pivotparlor.com/${shop.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gold hover:underline"
        >
          View live site
        </a>
      </p>
    </div>
  );
}
