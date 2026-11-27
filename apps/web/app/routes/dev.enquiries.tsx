import { Link, useFetcher, useLoaderData, useNavigation, data as json } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useMemo, useState } from "react";
import { Copy, ExternalLink } from "lucide-react";
import { getSessionToken, requireRole } from "~/lib/auth";
import { createApiClient } from "~/lib/api";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { StatusBadge } from "~/components/ui/StatusBadge";
import { formatDateTime } from "~/lib/dateFormat";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/Dialog";
import { readFormData, UNREADABLE_FORM } from "~/lib/formBody";
import { pageTitle } from "~/lib/pageTitle";
import { revalidateAfterFailedSubmission } from "~/lib/revalidation";
import { useFetcherResult } from "~/lib/useFetcherResult";

export const meta = () => pageTitle("Enquiries");

// Reload this page's data after a failed submission, as Remix 2 did (app/lib/revalidation.ts).
export const shouldRevalidate = revalidateAfterFailedSubmission;

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev" homeLabel="Back to overview" />;
}

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

/** The API hands enquiries back newest first, this many to a page. */
const PAGE_SIZE = 100;
/** The most this page will hold at once (ten pages). */
const MAX_SHOWN = 1000;

function slugBaseFromShopName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** How many enquiries `?show=` asks for: whole pages, between one page and the cap. */
function shownFromParam(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= PAGE_SIZE) return PAGE_SIZE;
  return Math.min(Math.ceil(n / PAGE_SIZE) * PAGE_SIZE, MAX_SHOWN);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  const shown = shownFromParam(new URL(request.url).searchParams.get("show"));
  const offsets = Array.from({ length: shown / PAGE_SIZE }, (_, i) => i * PAGE_SIZE);
  const pages = await Promise.allSettled(
    offsets.map((offset) => api.get<Enquiry[]>(`/api/contact?limit=${PAGE_SIZE}&offset=${offset}`)),
  );

  const enquiries: Enquiry[] = [];
  let loadError = false;
  // True when a later page failed: what is shown is real but not everything asked for.
  let olderMissing = false;
  let lastPageFull = false;
  for (const [i, page] of pages.entries()) {
    if (page.status === "rejected" || !Array.isArray(page.value)) {
      if (i === 0) loadError = true;
      else olderMissing = true;
      break;
    }
    enquiries.push(...page.value);
    lastPageFull = page.value.length === PAGE_SIZE;
    if (!lastPageFull) break;
  }

  return json({
    enquiries,
    loadError,
    olderMissing,
    shown,
    // A full last page means there may be older ones the page has not asked for.
    hasMore: !loadError && !olderMissing && lastPageFull,
  });
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
  await requireRole(request, "developer", env.API_URL);
  const token = getSessionToken(request);
  if (!token) {
    return json<OnboardFail>({ success: false, error: "Not signed in" }, { status: 401 });
  }

  const form = await readFormData(request);
  if (!form) return json<OnboardFail>({ success: false, error: UNREADABLE_FORM }, { status: 400 });
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

type OnboardedFilter = "all" | "open" | "onboarded";

export default function DevEnquiries() {
  const { enquiries, loadError, olderMissing, shown, hasMore } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<OnboardSuccess | OnboardFail>();
  const navigation = useNavigation();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selected, setSelected] = useState<Enquiry | null>(null);
  const [formShopName, setFormShopName] = useState("");
  const [formOwnerEmail, setFormOwnerEmail] = useState("");
  const [formShopType, setFormShopType] = useState("beauty_parlor");
  const [formSlug, setFormSlug] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [successPayload, setSuccessPayload] = useState<OnboardSuccess | null>(null);
  const [copied, setCopied] = useState<"payment" | "invite" | null>(null);
  const [messageEnquiry, setMessageEnquiry] = useState<Enquiry | null>(null);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<OnboardedFilter>("all");

  // Once per finished submission. A fetcher goes submitting, loading, idle,
  // and keeps its last answer, so neither "was submitting, now idle" nor
  // "idle with data" is a safe test (app/lib/useFetcherResult.ts).
  useFetcherResult(fetcher, (answer) => {
    if (answer.success) {
      setConfirmOpen(false);
      setActionError(null);
      setSuccessPayload(answer);
    } else {
      setActionError(answer.error || "The shop could not be created. Please try again.");
    }
  });
  const busy = fetcher.state !== "idle";

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return enquiries.filter((e) => {
      const onboarded = Boolean(e.onboarded_at);
      if (filter === "open" && onboarded) return false;
      if (filter === "onboarded" && !onboarded) return false;
      if (!needle) return true;
      return [e.full_name, e.shop_name, e.email, e.phone ?? "", e.message ?? ""].some((field) =>
        field.toLowerCase().includes(needle),
      );
    });
  }, [enquiries, query, filter]);
  const openCount = useMemo(() => enquiries.filter((e) => !e.onboarded_at).length, [enquiries]);

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
    setSuccessPayload(null);
    setCopied(null);
  }

  async function copy(text: string | undefined, what: "payment" | "invite") {
    if (!text || typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      /* clipboard refused: the link is on screen to copy by hand */
    }
  }

  const inviteUrl =
    successPayload?.invite_token && typeof window !== "undefined"
      ? `${window.location.origin}/invite/${successPayload.invite_token}`
      : null;
  const loadingMore = navigation.state === "loading" && navigation.location?.pathname === "/dev/enquiries";

  return (
    <div>
      <h1 className="mb-6 flex flex-wrap items-center gap-2 font-heading text-2xl font-bold text-white">
        Enquiries
        {!loadError && (
          <Badge variant="default" aria-label={`${enquiries.length}${hasMore ? " or more" : ""} loaded`}>
            {enquiries.length}
            {hasMore ? "+" : ""}
          </Badge>
        )}
      </h1>

      {loadError ? (
        <LoadError what="the enquiries" />
      ) : enquiries.length === 0 ? (
        <p className="rounded-xl border border-white/10 bg-dark-100 px-4 py-8 text-center text-sm text-white/60">
          No enquiries yet. Contact form submissions appear here.
        </p>
      ) : (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_14rem] sm:items-end">
            <Input
              type="search"
              label="Search enquiries"
              hideLabel
              placeholder="Search by name, shop, email, phone or message…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <Select label="Show" value={filter} onChange={(e) => setFilter(e.target.value as OnboardedFilter)}>
              <option value="all">All enquiries</option>
              <option value="open">Not yet onboarded ({openCount})</option>
              <option value="onboarded">Onboarded ({enquiries.length - openCount})</option>
            </Select>
          </div>

          <p className="mb-2 text-sm text-white/60" role="status">
            Showing {visible.length} of the {enquiries.length} newest enquiries loaded
            {hasMore ? ". Search and the filter cover only what is loaded; older ones are below." : "."}
          </p>

          {visible.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-dark-100 px-4 py-8 text-center text-sm text-white/60">
              <p>No loaded enquiries match.</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear search and filter
              </Button>
            </div>
          ) : (
            <ul aria-label="Enquiries" className="divide-y divide-white/5 rounded-xl border border-white/10 bg-dark-100">
              {visible.map((e) => {
                const onboarded = Boolean(e.onboarded_at);
                return (
                  <li
                    key={e.id}
                    className="grid gap-x-4 gap-y-2 px-4 py-4 hover:bg-white/[0.02] sm:px-5 md:grid-cols-[minmax(0,1.2fr)_minmax(0,1.3fr)_minmax(0,1.6fr)_auto] md:items-start"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-white">{e.full_name}</p>
                      <p className="text-sm text-white/70">
                        {e.shop_name}
                        <span className="capitalize text-white/60"> · {e.shop_type.replace(/_/g, " ")}</span>
                      </p>
                      <p className="mt-1 text-xs text-white/60">{formatDateTime(e.created_at)}</p>
                    </div>
                    <div className="min-w-0 text-sm">
                      <a href={`mailto:${e.email}`} className="tap-target inline-flex items-center break-all text-gold hover:underline">
                        {e.email}
                      </a>
                      <p>
                        {e.phone ? (
                          <a href={`tel:${e.phone}`} className="tap-target inline-flex items-center text-white/80 hover:text-white">
                            {e.phone}
                          </a>
                        ) : (
                          <span className="text-white/60">No phone given</span>
                        )}
                      </p>
                    </div>
                    <div className="min-w-0 text-sm">
                      {e.message ? (
                        <>
                          <p className="line-clamp-2 break-words text-white/80">{e.message}</p>
                          <button
                            type="button"
                            onClick={() => setMessageEnquiry(e)}
                            className="tap-target inline-flex items-center rounded text-sm text-gold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold"
                          >
                            Read message<span className="sr-only"> from {e.full_name}</span>
                          </button>
                        </>
                      ) : (
                        <p className="text-white/60">No message</p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                      {onboarded ? (
                        <>
                          <StatusBadge status="active" label="Onboarded" />
                          {e.shop_id && (
                            <Button asChild variant="ghost" size="sm">
                              <Link to={`/dev/shops/${e.shop_id}`}>
                                Open shop<span className="sr-only"> for {e.shop_name}</span>
                              </Link>
                            </Button>
                          )}
                        </>
                      ) : (
                        <Button type="button" size="sm" variant="outline" onClick={() => openOnboard(e)}>
                          Onboard<span className="sr-only"> {e.shop_name}</span>
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {olderMissing && (
            <p role="alert" className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
              Older enquiries could not be loaded. The {enquiries.length} above are complete; reload to try again.
            </p>
          )}
          {hasMore && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {shown < MAX_SHOWN ? (
                <Button asChild variant="secondary">
                  <Link to={`?show=${shown + PAGE_SIZE}`} replace preventScrollReset aria-disabled={loadingMore}>
                    {loadingMore ? "Loading…" : `Load ${PAGE_SIZE} older enquiries`}
                  </Link>
                </Button>
              ) : (
                <p className="text-sm text-white/70">
                  This page shows the newest {MAX_SHOWN} enquiries. Older ones are not listed here.
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Onboard: closed only by its own outcome, Cancel, or the close button while idle. */}
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirmOpen(false);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Onboard shop from enquiry</DialogTitle>
          </DialogHeader>
          {selected && (
            <fetcher.Form method="post" className="space-y-4" onSubmit={() => setActionError(null)}>
              <input type="hidden" name="intent" value="onboard" />
              <input type="hidden" name="contact_email" value={selected.email} />

              <Input
                label="Shop name"
                name="shop_name"
                value={formShopName}
                onChange={(ev) => setFormShopName(ev.target.value)}
                required
              />
              <Select
                label="Shop type"
                name="shop_type"
                value={formShopType}
                onChange={(ev) => setFormShopType(ev.target.value)}
                required
              >
                <option value="beauty_parlor">Beauty parlour</option>
                <option value="barber_shop">Barber shop</option>
                <option value="both">Both</option>
              </Select>
              <Input
                label="Owner email"
                name="owner_email"
                type="email"
                value={formOwnerEmail}
                onChange={(ev) => setFormOwnerEmail(ev.target.value)}
                required
              />
              <div>
                <Input
                  label="URL slug (base)"
                  name="slug"
                  value={formSlug}
                  onChange={(ev) => setFormSlug(ev.target.value)}
                  placeholder="auto from shop name"
                  autoCapitalize="off"
                  spellCheck={false}
                  aria-describedby="enquiry-slug-hint"
                />
                <p id="enquiry-slug-hint" className="mt-1 text-xs text-white/60">
                  A unique number is added for you, for example my-shop-012.
                </p>
              </div>

              {actionError && (
                <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                  {actionError}
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
                <Button type="button" variant="secondary" onClick={() => setConfirmOpen(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" disabled={busy}>
                  {busy ? "Creating…" : "Create shop"}
                </Button>
              </div>
            </fetcher.Form>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={successPayload !== null} onOpenChange={(o) => !o && closeSuccess()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Shop created</DialogTitle>
          </DialogHeader>
          {successPayload && (
            <div className="space-y-4">
              <p role="status" className="text-sm text-white/70">
                <span className="font-medium text-white">{successPayload.shop.name}</span> was created with the slug{" "}
                <code className="text-white">{successPayload.shop.slug}</code>.
              </p>

              {successPayload.checkout_url ? (
                <>
                  <p className="text-sm text-white/70">
                    Send the owner this Stripe payment link. Their invite activates once it is paid.
                  </p>
                  <div className="break-all rounded-lg border border-white/10 bg-dark p-3 font-mono text-sm text-white/80">
                    {successPayload.checkout_url}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void copy(successPayload.checkout_url, "payment")}
                    >
                      <Copy className="h-4 w-4" aria-hidden />
                      {copied === "payment" ? "Copied!" : "Copy payment link"}
                    </Button>
                    <Button asChild variant="ghost" size="sm">
                      <a href={successPayload.checkout_url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-4 w-4" aria-hidden />
                        Open link<span className="sr-only"> (opens in a new tab)</span>
                      </a>
                    </Button>
                  </div>
                </>
              ) : inviteUrl ? (
                <>
                  <p className="text-sm text-white/70">
                    No payment is needed here. Send the owner this invite link so they can set a password.
                  </p>
                  <div className="break-all rounded-lg border border-white/10 bg-dark p-3 font-mono text-sm text-white/80">
                    {inviteUrl}
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => void copy(inviteUrl, "invite")}>
                    <Copy className="h-4 w-4" aria-hidden />
                    {copied === "invite" ? "Copied!" : "Copy invite link"}
                  </Button>
                </>
              ) : (
                <p className="text-sm text-white/70">
                  No payment or invite link came back. Open the shop from the Shops list to continue.
                </p>
              )}

              <Button type="button" className="w-full" onClick={closeSuccess}>
                Done
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={messageEnquiry !== null} onOpenChange={(o) => !o && setMessageEnquiry(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Message from {messageEnquiry?.full_name}</DialogTitle>
          </DialogHeader>
          {messageEnquiry && (
            <div className="space-y-4">
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="mb-0.5 text-xs text-white/60">Shop</dt>
                  <dd className="text-white">{messageEnquiry.shop_name}</dd>
                </div>
                <div>
                  <dt className="mb-0.5 text-xs text-white/60">Email</dt>
                  <dd>
                    <a href={`mailto:${messageEnquiry.email}`} className="break-all text-gold hover:underline">
                      {messageEnquiry.email}
                    </a>
                  </dd>
                </div>
                {messageEnquiry.phone && (
                  <div>
                    <dt className="mb-0.5 text-xs text-white/60">Phone</dt>
                    <dd>
                      <a href={`tel:${messageEnquiry.phone}`} className="text-white/80 hover:text-white">
                        {messageEnquiry.phone}
                      </a>
                    </dd>
                  </div>
                )}
                <div>
                  <dt className="mb-0.5 text-xs text-white/60">Received</dt>
                  <dd className="text-white/70">{formatDateTime(messageEnquiry.created_at)}</dd>
                </div>
              </dl>
              <div className="whitespace-pre-wrap break-words rounded-lg border border-white/10 bg-white/5 p-4 text-sm leading-relaxed text-white/80">
                {messageEnquiry.message}
              </div>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button asChild variant="outline">
                  <a href={`mailto:${messageEnquiry.email}`}>Reply by email</a>
                </Button>
                <Button type="button" variant="secondary" onClick={() => setMessageEnquiry(null)}>
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
