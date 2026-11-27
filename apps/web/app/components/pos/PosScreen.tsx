import { Form, useFetcher, useNavigation, useSubmit } from "react-router";
import { useMemo, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Banknote, Check, CreditCard, Minus, Plus, QrCode, Scissors, ShoppingBag, Trash2 } from "lucide-react";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { Input } from "~/components/ui/Input";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { StatusBadge } from "~/components/ui/StatusBadge";
import type { PosActionData, PosProduct, PosSaleResult, PosService, PosStaff } from "~/lib/pos";
import { usePolling } from "~/lib/usePolling";
import { posTotals } from "./posTotals";

interface CartLine {
  key: string;
  type: "service" | "product";
  id: string;
  name: string;
  unit_pence: number;
  quantity: number;
}

const TENDERS = [
  { value: "cash", label: "Cash", icon: Banknote },
  { value: "card_external", label: "Card (own machine)", icon: CreditCard },
  { value: "stripe", label: "Stripe QR", icon: QrCode },
] as const;

const CATALOGUE_TABS = [
  { key: "services", label: "Services", icon: Scissors },
  { key: "products", label: "Products", icon: ShoppingBag },
] as const;
type CatalogueTab = (typeof CATALOGUE_TABS)[number]["key"];

const CART_ID = "pp-pos-cart";

export function PosScreen({
  shopId,
  services,
  products,
  staff,
  servicesError = false,
  productsError = false,
  staffError = false,
  canVoid,
  developerNeedsShop,
  actionData,
}: {
  shopId: string | null;
  services: PosService[];
  products: PosProduct[];
  staff: PosStaff[];
  /** True when that list could not be loaded: shown as a failed load, never as an empty catalogue. */
  servicesError?: boolean;
  productsError?: boolean;
  staffError?: boolean;
  canVoid: boolean;
  developerNeedsShop: boolean;
  actionData: PosActionData | undefined;
}) {
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";

  const [cart, setCart] = useState<CartLine[]>([]);
  const [tab, setTab] = useState<CatalogueTab>("services");
  const [search, setSearch] = useState("");
  const [tender, setTender] = useState<string>("cash");
  const [discount, setDiscount] = useState("");
  const [tip, setTip] = useState("");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const cartRef = useRef<HTMLFormElement>(null);

  // What the last submission did, kept in state so a later one cannot lose
  // it: a void that is refused answers with an error only, and the sale it
  // was for must stay on screen. Adjusted while rendering, when a new answer
  // arrives, so no frame shows the old screen.
  const [seenAction, setSeenAction] = useState<PosActionData | undefined>(undefined);
  const [sale, setSale] = useState<PosSaleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voided, setVoided] = useState(false);
  if (actionData !== seenAction) {
    setSeenAction(actionData);
    setError(actionData && "error" in actionData ? actionData.error : null);
    if (actionData && "sale" in actionData) {
      // Accepted by the API: the cart is spent.
      setSale(actionData.sale);
      setVoided(false);
      setCart([]);
      setDiscount("");
      setTip("");
    } else if (actionData && "voided" in actionData) {
      setSale(null);
      setVoided(true);
    }
  }

  const add = (line: Omit<CartLine, "key" | "quantity">) => {
    setVoided(false);
    setCart((prev) => {
      const existing = prev.find((l) => l.type === line.type && l.id === line.id);
      if (existing) {
        return prev.map((l) => (l === existing ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { ...line, key: `${line.type}:${line.id}`, quantity: 1 }];
    });
  };
  const bump = (key: string, delta: number) =>
    setCart((prev) =>
      prev
        .map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
    );
  const remove = (key: string) => setCart((prev) => prev.filter((l) => l.key !== key));
  const inCart = (type: CartLine["type"], id: string) =>
    cart.find((l) => l.type === type && l.id === id)?.quantity ?? 0;

  const subtotalPence = useMemo(
    () => cart.reduce((sum, l) => sum + l.unit_pence * l.quantity, 0),
    [cart]
  );
  const itemCount = cart.reduce((sum, l) => sum + l.quantity, 0);
  const totals = posTotals(subtotalPence, discount, tip);

  const query = search.trim().toLowerCase();
  const matches = (...fields: Array<string | null | undefined>) =>
    query === "" || fields.some((f) => f?.toLowerCase().includes(query));
  const shownServices = services.filter((s) => matches(s.name, s.category));
  const shownProducts = products.filter((p) => matches(p.name, p.brand, p.sku));

  const cartPayload = JSON.stringify(
    cart.map((l) => ({
      type: l.type,
      ...(l.type === "service" ? { serviceId: l.id } : { productId: l.id }),
      quantity: l.quantity,
    }))
  );

  const viewCart = () => {
    const el = cartRef.current;
    if (!el) return;
    const calm = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };

  if (developerNeedsShop) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
        Open this page with <code className="rounded bg-black/30 px-1">?shopId=…</code> to ring sales as a developer.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="font-heading text-2xl font-bold text-white">Point of Sale</h1>
        <p className="mt-0.5 text-sm text-white/60">
          Ring up services and products; take cash, your own card machine, or a Stripe QR payment.
        </p>
      </div>

      {sale ? (
        <SaleResultPanel
          // A new sale is a new panel: its own polling clock and dialogs.
          key={sale.id}
          sale={sale}
          shopId={shopId}
          canVoid={canVoid}
          voiding={nav.state !== "idle" && nav.formData?.get("intent") === "void"}
          error={error}
          onNewSale={() => {
            setSale(null);
            setError(null);
          }}
        />
      ) : (
        <>
          {voided && (
            <p role="status" className="mb-4 flex items-center gap-2 rounded-lg border border-white/10 bg-dark-100 px-4 py-3 text-sm text-white/80">
              <Check className="h-4 w-4 shrink-0 text-white/70" aria-hidden /> Sale voided. Nothing was charged for it.
            </p>
          )}
          <div className="grid gap-6 lg:grid-cols-2">
            {/* Catalogue picker */}
            <div>
              <div role="tablist" aria-label="Catalogue" className="mb-3 flex gap-2">
                {CATALOGUE_TABS.map((t, i) => {
                  const selected = tab === t.key;
                  return (
                    <button
                      key={t.key}
                      ref={(el) => { tabRefs.current[t.key] = el; }}
                      type="button"
                      role="tab"
                      id={`pp-pos-tab-${t.key}`}
                      aria-selected={selected}
                      aria-controls="pp-pos-catalogue"
                      tabIndex={selected ? 0 : -1}
                      onClick={() => setTab(t.key)}
                      onKeyDown={(e) => {
                        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                        e.preventDefault();
                        const other = CATALOGUE_TABS[(i + 1) % CATALOGUE_TABS.length]!;
                        setTab(other.key);
                        tabRefs.current[other.key]?.focus();
                      }}
                      className={`tap-target flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                        selected
                          ? "border-gold bg-gold/10 font-semibold text-gold"
                          : "border-white/10 font-medium text-white/60 hover:text-white"
                      }`}
                    >
                      <t.icon className="h-3.5 w-3.5" aria-hidden /> {t.label}
                    </button>
                  );
                })}
              </div>

              <div className="mb-3">
                <Input
                  label="Search services and products"
                  hideLabel
                  type="search"
                  placeholder={tab === "services" ? "Search services" : "Search products"}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  autoComplete="off"
                />
              </div>

              {/* Below lg the page itself scrolls: a list that scrolls inside the
                  page hides the cart and traps a thumb. From lg up the cart sits
                  beside it, so the list keeps its own scroll. */}
              <div
                role="tabpanel"
                id="pp-pos-catalogue"
                aria-labelledby={`pp-pos-tab-${tab}`}
                className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:max-h-[28rem] lg:overflow-y-auto lg:pr-1"
              >
                {tab === "services" &&
                  (servicesError ? (
                    <LoadError what="the services" className="sm:col-span-2" />
                  ) : services.length === 0 ? (
                    <p className="text-sm text-white/60 sm:col-span-2">No services yet.</p>
                  ) : shownServices.length === 0 ? (
                    <p className="text-sm text-white/60 sm:col-span-2">No services match that search.</p>
                  ) : (
                    shownServices.map((s) => (
                      <CatalogueButton
                        key={s.id}
                        name={s.name}
                        quantity={inCart("service", s.id)}
                        onAdd={() => add({ type: "service", id: s.id, name: s.name, unit_pence: s.price_pence })}
                      >
                        <span className="mt-0.5 block text-xs text-gold">{formatPence(s.price_pence)}</span>
                      </CatalogueButton>
                    ))
                  ))}
                {tab === "products" &&
                  (productsError ? (
                    <LoadError what="the products" className="sm:col-span-2" />
                  ) : products.length === 0 ? (
                    <p className="text-sm text-white/60 sm:col-span-2">No retail products yet. Add them under Products.</p>
                  ) : shownProducts.length === 0 ? (
                    <p className="text-sm text-white/60 sm:col-span-2">No products match that search.</p>
                  ) : (
                    shownProducts.map((p) => (
                      <CatalogueButton
                        key={p.id}
                        name={p.name}
                        quantity={inCart("product", p.id)}
                        onAdd={() => add({ type: "product", id: p.id, name: p.name, unit_pence: p.retail_price_pence })}
                      >
                        {(p.brand || p.sku) && (
                          <span className="mt-0.5 block text-xs text-white/60">
                            {[p.brand, p.sku].filter(Boolean).join(" · ")}
                          </span>
                        )}
                        <span className="mt-0.5 block text-xs">
                          <span className="text-gold">{formatPence(p.retail_price_pence)}</span>
                          {p.track_stock === 1 && (
                            <span className={`ml-2 ${p.total_quantity <= 0 ? "font-semibold text-red-300" : "text-white/60"}`}>
                              {p.total_quantity <= 0 ? "Out of stock" : `${p.total_quantity} in stock`}
                            </span>
                          )}
                        </span>
                      </CatalogueButton>
                    ))
                  ))}
              </div>
            </div>

            {/* Cart + checkout */}
            <Form
              ref={cartRef}
              id={CART_ID}
              tabIndex={-1}
              method="post"
              aria-labelledby="pp-pos-cart-title"
              className="scroll-mt-20 space-y-4 rounded-xl border border-white/10 bg-dark-100 p-4 focus:outline-none"
            >
              <input type="hidden" name="intent" value="sale" />
              {shopId && <input type="hidden" name="shopId" value={shopId} />}
              <input type="hidden" name="cart" value={cartPayload} />
              <input type="hidden" name="tender" value={tender} />

              <h2 id="pp-pos-cart-title" className="text-xs font-semibold uppercase tracking-widest text-white/60">
                Cart
              </h2>
              {cart.length === 0 ? (
                <p className="text-sm text-white/60">Tap a service or product to add it.</p>
              ) : (
                <ul className="space-y-2">
                  {cart.map((l) => (
                    <li key={l.key} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-[8rem] flex-1 break-words text-white">{l.name}</span>
                      {/* Quantity and remove controls: 44px on touch, right-aligned on their own line when the name needs the room */}
                      <div className="ml-auto flex items-center gap-2">
                        <button type="button" onClick={() => bump(l.key, -1)} aria-label={`Remove one ${l.name}`}
                          className="tap-target flex items-center justify-center rounded border border-white/10 p-1.5 text-white/60 hover:text-white">
                          <Minus className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <span className="w-6 text-center text-white" aria-label={`Quantity ${l.quantity}`}>{l.quantity}</span>
                        <button type="button" onClick={() => bump(l.key, 1)} aria-label={`Add one ${l.name}`}
                          className="tap-target flex items-center justify-center rounded border border-white/10 p-1.5 text-white/60 hover:text-white">
                          <Plus className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        <span className="w-16 text-right text-gold">{formatPence(l.unit_pence * l.quantity)}</span>
                        <button type="button" onClick={() => remove(l.key)} aria-label={`Remove ${l.name}`}
                          className="tap-target flex items-center justify-center rounded border border-red-500/20 p-1.5 text-red-300 hover:bg-red-500/10">
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Discount (£)"
                  name="discount"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  error={totals.discountError}
                />
                <Input
                  label="Tip (£)"
                  name="tip"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={tip}
                  onChange={(e) => setTip(e.target.value)}
                  error={totals.tipError}
                />
              </div>

              {staffError ? (
                <LoadError what="the staff list" />
              ) : (
                staff.length > 0 && (
                  <Select label="Staff member" name="staff_id" defaultValue="">
                    <option value="">Not attributed</option>
                    {staff.map((s) => (
                      <option key={s.id} value={s.id}>{s.display_name}</option>
                    ))}
                  </Select>
                )
              )}

              <Input label="Customer email (receipt, optional)" name="customer_email" type="email" placeholder="customer@example.com" />
              <Input label="Note (optional)" name="note" type="text" maxLength={200} autoComplete="off" />

              <div role="group" aria-labelledby="pp-pos-payment">
                <p id="pp-pos-payment" className="mb-1.5 text-sm font-medium text-white/80">Payment</p>
                <div className="flex flex-wrap gap-2">
                  {TENDERS.map((t) => {
                    const pressed = tender === t.value;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        aria-pressed={pressed}
                        onClick={() => setTender(t.value)}
                        className={`tap-target flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
                          pressed
                            ? "border-gold bg-gold/10 font-semibold text-gold"
                            : "border-white/10 font-medium text-white/60 hover:text-white"
                        }`}
                      >
                        {pressed ? <Check className="h-4 w-4" aria-hidden /> : <t.icon className="h-4 w-4" aria-hidden />}
                        {t.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* What to charge, worked out as the sales API does (posTotals) */}
              <dl className="space-y-1 border-t border-white/10 pt-3 text-sm">
                <Row label="Subtotal" value={formatPence(subtotalPence)} />
                {totals.discountPence !== null && totals.discountPence > 0 && (
                  <Row label="Discount" value={`-${formatPence(totals.discountPence)}`} />
                )}
                {totals.tipPence !== null && totals.tipPence > 0 && (
                  <Row label="Tip" value={`+${formatPence(totals.tipPence)}`} />
                )}
                <div className="flex items-center justify-between border-t border-white/10 pt-2">
                  <dt className="font-semibold text-white">Total to collect</dt>
                  <dd className="text-2xl font-bold text-gold">
                    {totals.totalPence === null ? "Check the amounts above" : formatPence(totals.totalPence)}
                  </dd>
                </div>
              </dl>
              <p className="text-xs text-white/60">
                If your shop passes the service fee to customers, it is added when the sale is made and shown on the
                next screen.
              </p>

              {error && (
                <p className="text-sm text-red-300" role="alert">{error}</p>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting || cart.length === 0 || totals.totalPence === null}
              >
                {isSubmitting
                  ? "Processing…"
                  : tender === "stripe"
                    ? "Create payment QR"
                    : "Complete sale"}
              </Button>
            </Form>
          </div>

          {/* Phones and small tablets: the cart is below the catalogue, out of
              sight. This bar stays above the tab bar (3.5rem plus its hairline
              and the safe area) and says what is in the cart as it fills. */}
          {cart.length > 0 && (
            <div className="sticky bottom-[calc(3.5rem+1px+env(safe-area-inset-bottom)+var(--pp-cookie-notice-h,0px))] z-20 -mx-4 mt-6 flex items-center justify-between gap-3 border-t border-white/10 bg-dark/95 px-4 py-2 backdrop-blur-md md:bottom-0 md:-mx-6 md:px-6 lg:hidden">
              <p role="status" className="min-w-0 text-sm text-white">
                <span className="font-semibold">
                  {itemCount} {itemCount === 1 ? "item" : "items"}
                </span>
                <span className="text-white/70">
                  {" · "}
                  {totals.totalPence === null ? formatPence(subtotalPence) : formatPence(totals.totalPence)}
                </span>
              </p>
              <Button type="button" variant="outline" size="sm" onClick={viewCart} aria-controls={CART_ID}>
                View cart
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One catalogue tile. It says how many are already in the cart, so a tap is seen to have landed. */
function CatalogueButton({
  name,
  quantity,
  onAdd,
  children,
}: {
  name: string;
  quantity: number;
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onAdd}
      aria-label={quantity > 0 ? `Add ${name}. ${quantity} in the cart` : `Add ${name}`}
      className={`tap-target rounded-xl border p-3 text-left transition-colors hover:border-gold/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold ${
        quantity > 0 ? "border-gold/50 bg-gold/5" : "border-white/10 bg-dark-100"
      }`}
    >
      <span className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words text-sm font-medium text-white">{name}</span>
        {quantity > 0 && (
          <span className="shrink-0 rounded-full bg-gold/20 px-2 py-0.5 text-xs font-semibold text-gold">
            {quantity} in cart
          </span>
        )}
      </span>
      {children}
    </button>
  );
}

// ─── Post-sale panel: receipt or live QR payment ──────────────────────────────

/** How long the till keeps asking whether a QR payment has landed. */
const WATCH_MS = 10 * 60 * 1000;

function SaleResultPanel({
  sale,
  shopId,
  canVoid,
  voiding,
  error,
  onNewSale,
}: {
  sale: PosSaleResult;
  shopId: string | null;
  canVoid: boolean;
  /** True while the void is being sent. */
  voiding: boolean;
  /** Why the last void was refused, if it was. */
  error: string | null;
  onNewSale: () => void;
}) {
  const poll = useFetcher<{ success: boolean; data?: { status: string } }>();
  const submit = useSubmit();
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [watchStart, setWatchStart] = useState(() => Date.now());
  const [gaveUp, setGaveUp] = useState(false);

  // The latest answer wins; until one arrives, what the sale was created as.
  const status = poll.data?.data?.status ?? sale.status;
  const paid = status === "completed";
  const voided = status === "voided";
  const awaiting = sale.tender_type === "stripe" && status === "pending";
  const statusUrl = shopId ? `/api/shops/${shopId}/sales/${sale.id}` : null;

  // A pending Stripe sale settles by webhook: ask every 3 seconds while this
  // screen is being looked at, and stop after 10 minutes rather than for ever.
  usePolling(
    () => {
      if (statusUrl && poll.state === "idle") void poll.load(statusUrl);
      if (Date.now() - watchStart >= WATCH_MS) setGaveUp(true);
    },
    { intervalMs: 3000, enabled: awaiting && statusUrl !== null && !gaveUp },
  );

  const checkAgain = () => {
    setWatchStart(Date.now());
    setGaveUp(false);
    if (statusUrl && poll.state === "idle") void poll.load(statusUrl);
  };

  const sendVoid = () => {
    void submit(
      { intent: "void", saleId: sale.id, ...(shopId ? { shopId } : {}) },
      { method: "post" },
    );
  };

  const canVoidNow = canVoid && !voided && !(sale.tender_type === "stripe" && paid);
  const tookMoney = sale.tender_type !== "stripe" && paid;

  return (
    <div className="max-w-xl space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-heading text-lg font-bold text-white">
          {voided ? "Sale voided" : paid ? "Sale complete" : "Awaiting payment"}
        </h2>
        {/* role=status: a payment landing is announced, not only recoloured */}
        <span role="status">
          <StatusBadge
            status={paid ? "paid" : voided ? "voided" : status}
            label={awaiting ? "Awaiting payment" : undefined}
          />
        </span>
      </div>

      <dl className="space-y-1 text-sm">
        <Row label="Subtotal" value={formatPence(sale.subtotal_pence)} />
        {sale.discount_pence > 0 && <Row label="Discount" value={`-${formatPence(sale.discount_pence)}`} />}
        {sale.tip_pence > 0 && <Row label="Tip" value={`+${formatPence(sale.tip_pence)}`} />}
        {sale.commission_pence > 0 && <Row label="Service fee" value={`+${formatPence(sale.commission_pence)}`} />}
        <div className="flex items-center justify-between border-t border-white/10 pt-2">
          <dt className="font-semibold text-white">Total</dt>
          <dd className="text-2xl font-bold text-gold">{formatPence(sale.total_pence)}</dd>
        </div>
      </dl>

      {awaiting && sale.payment_url && (
        <div className="space-y-3 text-center">
          {/* A QR code needs a white ground to scan; only the code sits on it. */}
          <div className="mx-auto w-fit rounded-lg bg-white p-4">
            <QRCode value={sale.payment_url} size={180} aria-label="QR code for the customer to pay" />
          </div>
          <p className="text-sm text-white/70">
            Ask the customer to scan and pay on their phone. This screen updates when the payment lands.
          </p>
          <a
            href={sale.payment_url}
            target="_blank"
            rel="noopener noreferrer"
            className="tap-target inline-flex items-center justify-center text-sm text-gold underline underline-offset-4 hover:text-gold/80"
          >
            Or open the payment page on this device
          </a>
        </div>
      )}

      {awaiting && gaveUp && (
        <div role="status" className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
          <p className="text-sm text-amber-100">
            No payment has come through in 10 minutes, so this screen has stopped checking. If the customer has
            just paid, check again.
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={checkAgain} disabled={poll.state !== "idle"}>
            {poll.state !== "idle" ? "Checking…" : "Check again"}
          </Button>
        </div>
      )}

      {error && !confirmVoid && (
        <p role="alert" className="text-sm text-red-300">{error}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          className="flex-1"
          onClick={() => (awaiting ? setConfirmLeave(true) : onNewSale())}
        >
          New sale
        </Button>
        {canVoidNow && (
          <Button type="button" variant="outline" className="flex-1" disabled={voiding} onClick={() => setConfirmVoid(true)}>
            {voiding ? "Voiding…" : "Void sale"}
          </Button>
        )}
      </div>

      <ConfirmDialog
        open={confirmVoid}
        onCancel={() => setConfirmVoid(false)}
        onConfirm={sendVoid}
        title="Void this sale?"
        confirmLabel={`Void ${formatPence(sale.total_pence)} sale`}
        cancelLabel="Keep sale"
        destructive
        pending={voiding}
        pendingLabel="Voiding…"
        error={error}
      >
        <p>
          The sale of {formatPence(sale.total_pence)} is cancelled and any products on it go back into stock. A
          voided sale cannot be brought back: you would ring it up again.
        </p>
        {tookMoney && <p>Voiding does not return the money. Give the customer back what they paid.</p>}
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmLeave}
        onCancel={() => setConfirmLeave(false)}
        onConfirm={() => {
          setConfirmLeave(false);
          onNewSale();
        }}
        title="Leave this payment waiting?"
        confirmLabel="Start a new sale"
        cancelLabel="Stay on this payment"
      >
        <p>
          The customer has not paid the {formatPence(sale.total_pence)} yet. Starting a new sale does not cancel
          it: they can still pay with the QR code for about 30 minutes, but this screen will no longer show you
          when they do.
        </p>
        <p>
          {canVoid
            ? "If they are not going to pay, void the sale first."
            : "If they are not going to pay, ask the shop owner to void the sale."}
        </p>
      </ConfirmDialog>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-white/60">{label}</dt>
      <dd className="text-white">{value}</dd>
    </div>
  );
}
