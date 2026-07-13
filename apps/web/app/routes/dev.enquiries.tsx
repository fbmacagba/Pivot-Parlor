import { useFetcher, useLoaderData, useRevalidator } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useEffect, useRef, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/Dialog";

interface Enquiry {
  id: string;
  full_name: string;
  shop_name: string;
  shop_type: string;
  email: string;
  phone?: string | null;
  message?: string | null;
  created_at: string;
  onboarded_at?: string | null;
  shop_id?: string | null;
}

function slugBaseFromShopName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  let enquiries: Enquiry[] = [];
  try {
    enquiries = await api.get<Enquiry[]>("/api/contact");
  } catch {
    /* empty */
  }
  return json({ enquiries });
}

type OnboardSuccess = {
  success: true;
  shop: { id: string; slug: string; name: string };
  checkout_url?: string;
  invite_token?: string;
};

type OnboardFail = { success: false; error: string };

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) {
    return json<OnboardFail>({ success: false, error: "Not signed in" }, { status: 401 });
  }

  const form = await request.formData();
  if (form.get("intent") !== "onboard") {
    return json<OnboardFail>({ success: false, error: "Invalid action" }, { status: 400 });
  }

  const name = String(form.get("shop_name") ?? "").trim();
  const owner_email = String(form.get("owner_email") ?? "").trim().toLowerCase();
  const type = String(form.get("shop_type") ?? "beauty_parlor").trim();
  const slugBase = String(form.get("slug") ?? "").trim();
  const contact_email = String(form.get("contact_email") ?? "").trim().toLowerCase();

  if (!name || !owner_email || !contact_email) {
    return json<OnboardFail>({ success: false, error: "Shop name and owner email are required" }, { status: 400 });
  }

  const validTypes = ["barber_shop", "beauty_parlor", "both"];
  if (!validTypes.includes(type)) {
    return json<OnboardFail>({ success: false, error: "Invalid shop type" }, { status: 400 });
  }

  const api = createApiClient(env.API_URL, token);

  try {
    const data = await api.post<{
      shop: { id: string; slug: string; name: string };
      checkout_url?: string;
      invite_token?: string;
    }>("/api/shops", {
      name,
      owner_email,
      type,
      ...(slugBase ? { slug: slugBase } : {}),
      contact_email,
    });

    return json<OnboardSuccess>({
      success: true,
      shop: data.shop,
      checkout_url: data.checkout_url,
      invite_token: data.invite_token,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Failed to create shop";
    return json<OnboardFail>({ success: false, error: msg }, { status: 400 });
  }
}

export default function DevEnquiries() {
  const { enquiries } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [successOpen, setSuccessOpen] = useState(false);
  const [selected, setSelected] = useState<Enquiry | null>(null);
  const [formShopName, setFormShopName] = useState("");
  const [formOwnerEmail, setFormOwnerEmail] = useState("");
  const [formShopType, setFormShopType] = useState("beauty_parlor");
  const [formSlug, setFormSlug] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [successPayload, setSuccessPayload] = useState<OnboardSuccess | null>(null);
  const [copied, setCopied] = useState(false);
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageEnquiry, setMessageEnquiry] = useState<Enquiry | null>(null);

  const prevFetcherState = useRef(fetcher.state);

  useEffect(() => {
    if (prevFetcherState.current === "submitting" && fetcher.state === "idle" && fetcher.data) {
      const d = fetcher.data;
      if ("success" in d && d.success) {
        setConfirmOpen(false);
        setActionError(null);
        setSuccessPayload(d);
        setSuccessOpen(true);
        revalidator.revalidate();
      } else if ("success" in d && !d.success && "error" in d) {
        setActionError(d.error);
      }
    }
    prevFetcherState.current = fetcher.state;
  }, [fetcher.state, fetcher.data, revalidator]);

  function openOnboard(e: Enquiry) {
    setSelected(e);
    setFormShopName(e.shop_name);
    setFormOwnerEmail(e.email);
    setFormShopType(e.shop_type);
    setFormSlug(slugBaseFromShopName(e.shop_name));
    setActionError(null);
    setConfirmOpen(true);
  }

  function closeSuccess() {
    setSuccessOpen(false);
    setSuccessPayload(null);
    setCopied(false);
    revalidator.revalidate();
  }

  async function copyCheckoutUrl() {
    const url = successPayload?.checkout_url;
    if (!url || typeof navigator === "undefined" || !navigator.clipboard) return;
    await navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">
        Enquiries <Badge variant="gold">{enquiries.length}</Badge>
      </h1>

      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              {["Name", "Shop", "Type", "Email", "Phone", "Message", "Date", "Actions"].map((h) => (
                <th
                  key={h}
                  className={
                    h === "Actions"
                      ? "px-4 py-3 text-left text-xs font-semibold text-white/60 uppercase tracking-wider whitespace-nowrap min-w-[8.5rem]"
                      : "px-4 py-3 text-left text-xs font-semibold text-white/60 uppercase tracking-wider"
                  }
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {enquiries.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-white/60">
                  No enquiries yet.
                </td>
              </tr>
            ) : (
              enquiries.map((e) => {
                const onboarded = Boolean(e.onboarded_at);
                return (
                  <tr key={e.id} className="hover:bg-white/2">
                    <td className="px-4 py-3 font-medium text-white">{e.full_name}</td>
                    <td className="px-4 py-3 text-white/70">{e.shop_name}</td>
                    <td className="px-4 py-3 text-white/60 capitalize">{e.shop_type.replace(/_/g, " ")}</td>
                    <td className="px-4 py-3 text-white/60">{e.email}</td>
                    <td className="px-4 py-3 text-white/50 text-xs max-w-[120px] truncate" title={e.phone ?? ""}>
                      {e.phone || "—"}
                    </td>
                    <td className="px-4 py-3 text-white/50 text-xs max-w-[200px]">
                      {e.message ? (
                        <button
                          type="button"
                          onClick={() => { setMessageEnquiry(e); setMessageOpen(true); }}
                          className="truncate block max-w-[200px] text-left hover:text-gold transition-colors underline decoration-dotted"
                          title="Click to read full message"
                        >
                          {e.message}
                        </button>
                      ) : "—"}
                    </td>
                    <td className="px-4 py-3 text-white/60 text-xs whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    {/* Always render Actions cell — onboarded_at only toggles button vs disabled state */}
                    <td className="px-4 py-3 whitespace-nowrap align-middle">
                      {onboarded ? (
                        <Button type="button" size="sm" variant="outline" disabled className="opacity-70 cursor-not-allowed">
                          Onboarded
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => openOnboard(e)}>
                          Onboard
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Onboard shop from enquiry</DialogTitle>
          </DialogHeader>
          {selected && (
            <fetcher.Form method="post" className="space-y-4">
              <input type="hidden" name="intent" value="onboard" />
              <input type="hidden" name="contact_email" value={selected.email} />

              <Input
                label="Shop name"
                name="shop_name"
                value={formShopName}
                onChange={(ev) => setFormShopName(ev.target.value)}
                required
              />
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">Shop type</label>
                <select
                  name="shop_type"
                  value={formShopType}
                  onChange={(ev) => setFormShopType(ev.target.value)}
                  required
                  className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
                >
                  <option value="beauty_parlor" className="bg-dark">
                    Beauty parlour
                  </option>
                  <option value="barber_shop" className="bg-dark">
                    Barber shop
                  </option>
                  <option value="both" className="bg-dark">
                    Both
                  </option>
                </select>
              </div>
              <Input
                label="Owner email"
                name="owner_email"
                type="email"
                value={formOwnerEmail}
                onChange={(ev) => setFormOwnerEmail(ev.target.value)}
                required
              />
              <Input
                label="URL slug (base)"
                name="slug"
                value={formSlug}
                onChange={(ev) => setFormSlug(ev.target.value)}
                placeholder="auto from shop name"
              />
              <p className="text-xs text-white/60">
                A unique number suffix is added automatically (e.g. <span className="text-white/60">my-shop-012</span>
                ).
              </p>

              {actionError && (
                <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {actionError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setConfirmOpen(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={fetcher.state === "submitting"}>
                  {fetcher.state === "submitting" ? "Creating…" : "Confirm onboard"}
                </Button>
              </div>
            </fetcher.Form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={successOpen} onOpenChange={(o) => !o && closeSuccess()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Shop created</DialogTitle>
          </DialogHeader>
          {successPayload && (
            <div className="space-y-4">
              <p className="text-sm text-white/70">
                <span className="text-white font-medium">{successPayload.shop.name}</span> — slug{" "}
                <code className="text-gold text-xs">{successPayload.shop.slug}</code>
              </p>

              {successPayload.checkout_url ? (
                <>
                  <p className="text-sm text-white/60">Send the owner this Stripe payment link:</p>
                  <div className="rounded-lg border border-white/10 bg-dark p-3 break-all text-xs text-white/80">
                    {successPayload.checkout_url}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" size="sm" onClick={() => void copyCheckoutUrl()}>
                      <Copy className="h-4 w-4 mr-2" />
                      {copied ? "Copied!" : "Copy payment link"}
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <a href={successPayload.checkout_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4 mr-2" />
                        Open link
                      </a>
                    </Button>
                  </div>
                </>
              ) : successPayload.invite_token ? (
                <p className="text-sm text-white/60">
                  Legacy flow: invite created (no Stripe checkout). Check dev shops for the invite link.
                </p>
              ) : null}

              <Button type="button" className="w-full" onClick={closeSuccess}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={messageOpen} onOpenChange={setMessageOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Message from {messageEnquiry?.full_name}</DialogTitle>
          </DialogHeader>
          {messageEnquiry && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-white/60 mb-0.5">Shop</p>
                  <p className="text-white">{messageEnquiry.shop_name}</p>
                </div>
                <div>
                  <p className="text-xs text-white/60 mb-0.5">Email</p>
                  <a href={`mailto:${messageEnquiry.email}`} className="text-gold hover:underline">{messageEnquiry.email}</a>
                </div>
                {messageEnquiry.phone && (
                  <div>
                    <p className="text-xs text-white/60 mb-0.5">Phone</p>
                    <a href={`tel:${messageEnquiry.phone}`} className="text-white/70 hover:text-white">{messageEnquiry.phone}</a>
                  </div>
                )}
                <div>
                  <p className="text-xs text-white/60 mb-0.5">Received</p>
                  <p className="text-white/60">{new Date(messageEnquiry.created_at).toLocaleString()}</p>
                </div>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/5 p-4 text-sm text-white/80 whitespace-pre-wrap leading-relaxed">
                {messageEnquiry.message}
              </div>
              <div className="flex gap-2 justify-end">
                <Button asChild variant="outline" size="sm">
                  <a href={`mailto:${messageEnquiry.email}`}>Reply by email</a>
                </Button>
                <Button type="button" onClick={() => setMessageOpen(false)}>Close</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

    </div>
  );
}
