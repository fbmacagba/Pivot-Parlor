import { Form, useFetcher, useNavigation } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Banknote, CreditCard, Minus, Plus, QrCode, Scissors, ShoppingBag, Trash2 } from "lucide-react";
import { formatPence } from "@repo/utils";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import type { PosActionData, PosProduct, PosSaleResult, PosService, PosStaff } from "~/lib/pos";

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

export function PosScreen({
  shopId,
  services,
  products,
  staff,
  canVoid,
  developerNeedsShop,
  actionData,
}: {
  shopId: string | null;
  services: PosService[];
  products: PosProduct[];
  staff: PosStaff[];
  canVoid: boolean;
  developerNeedsShop: boolean;
  actionData: PosActionData | undefined;
}) {
  const nav = useNavigation();
  const isSubmitting = nav.state === "submitting";

  const [cart, setCart] = useState<CartLine[]>([]);
  const [tab, setTab] = useState<"services" | "products">("services");
  const [tender, setTender] = useState<string>("cash");
  const [dismissedSaleId, setDismissedSaleId] = useState<string | null>(null);

  const sale =
    actionData && "sale" in actionData && actionData.sale.id !== dismissedSaleId
      ? actionData.sale
      : null;

  // Clear the cart once a sale has been accepted by the worker.
  const lastSaleRef = useRef<string | null>(null);
  useEffect(() => {
    if (sale && lastSaleRef.current !== sale.id) {
      lastSaleRef.current = sale.id;
      setCart([]);
    }
  }, [sale]);

  const add = (line: Omit<CartLine, "key" | "quantity">) => {
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

  const subtotalPence = useMemo(
    () => cart.reduce((sum, l) => sum + l.unit_pence * l.quantity, 0),
    [cart]
  );

  const cartPayload = JSON.stringify(
    cart.map((l) => ({
      type: l.type,
      ...(l.type === "service" ? { serviceId: l.id } : { productId: l.id }),
      quantity: l.quantity,
    }))
  );

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
          sale={sale}
          shopId={shopId}
          canVoid={canVoid}
          isSubmitting={isSubmitting}
          onNewSale={() => setDismissedSaleId(sale.id)}
        />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Catalogue picker */}
          <div>
            <div className="mb-3 flex gap-2">
              <button
                type="button"
                onClick={() => setTab("services")}
                className={`tap-target flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  tab === "services" ? "border-gold text-gold" : "border-white/10 text-white/60 hover:text-white"
                }`}
              >
                <Scissors className="h-3.5 w-3.5" /> Services
              </button>
              <button
                type="button"
                onClick={() => setTab("products")}
                className={`tap-target flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  tab === "products" ? "border-gold text-gold" : "border-white/10 text-white/60 hover:text-white"
                }`}
              >
                <ShoppingBag className="h-3.5 w-3.5" /> Products
              </button>
            </div>

            <div className="grid max-h-[28rem] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              {tab === "services" &&
                services.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => add({ type: "service", id: s.id, name: s.name, unit_pence: s.price_pence })}
                    className="rounded-xl border border-white/10 bg-dark-100 p-3 text-left transition-colors hover:border-gold/50"
                  >
                    <p className="truncate text-sm font-medium text-white">{s.name}</p>
                    <p className="mt-0.5 text-xs text-gold">{formatPence(s.price_pence)}</p>
                  </button>
                ))}
              {tab === "products" &&
                products.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => add({ type: "product", id: p.id, name: p.name, unit_pence: p.retail_price_pence })}
                    className="rounded-xl border border-white/10 bg-dark-100 p-3 text-left transition-colors hover:border-gold/50"
                  >
                    <p className="truncate text-sm font-medium text-white">{p.name}</p>
                    <p className="mt-0.5 text-xs text-white/60">
                      {[p.brand, p.sku].filter(Boolean).join(" · ")}
                    </p>
                    <p className="mt-0.5 text-xs">
                      <span className="text-gold">{formatPence(p.retail_price_pence)}</span>
                      {p.track_stock === 1 && (
                        <span className={`ml-2 ${p.total_quantity <= 0 ? "text-red-400" : "text-white/60"}`}>
                          {p.total_quantity} in stock
                        </span>
                      )}
                    </p>
                  </button>
                ))}
              {tab === "services" && services.length === 0 && (
                <p className="text-sm text-white/60">No services yet.</p>
              )}
              {tab === "products" && products.length === 0 && (
                <p className="text-sm text-white/60">No retail products yet — add them under Products.</p>
              )}
            </div>
          </div>

          {/* Cart + checkout */}
          <Form method="post" className="space-y-4 rounded-xl border border-white/10 bg-dark-100 p-4">
            <input type="hidden" name="intent" value="sale" />
            {shopId && <input type="hidden" name="shopId" value={shopId} />}
            <input type="hidden" name="cart" value={cartPayload} />
            <input type="hidden" name="tender" value={tender} />

            <p className="text-xs font-semibold uppercase tracking-widest text-white/50">Cart</p>
            {cart.length === 0 ? (
              <p className="text-sm text-white/60">Tap a service or product to add it.</p>
            ) : (
              <ul className="space-y-2">
                {cart.map((l) => (
                  <li key={l.key} className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-[8rem] flex-1 truncate text-white">{l.name}</span>
                    {/* Quantity and remove controls: 44px on touch, right-aligned on their own line when the name needs the room */}
                    <div className="ml-auto flex items-center gap-2">
                      <button type="button" onClick={() => bump(l.key, -1)} aria-label={`Remove one ${l.name}`}
                        className="tap-target flex items-center justify-center rounded border border-white/10 p-1.5 text-white/60 hover:text-white">
                        <Minus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-6 text-center text-white">{l.quantity}</span>
                      <button type="button" onClick={() => bump(l.key, 1)} aria-label={`Add one ${l.name}`}
                        className="tap-target flex items-center justify-center rounded border border-white/10 p-1.5 text-white/60 hover:text-white">
                        <Plus className="h-3.5 w-3.5" />
                      </button>
                      <span className="w-16 text-right text-gold">{formatPence(l.unit_pence * l.quantity)}</span>
                      <button type="button" onClick={() => remove(l.key)} aria-label={`Remove ${l.name}`}
                        className="tap-target flex items-center justify-center rounded border border-red-500/20 p-1.5 text-red-400/80 hover:bg-red-500/10">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Input label="Discount (£)" name="discount" type="number" min="0" step="0.01" placeholder="0.00" />
              <Input label="Tip (£)" name="tip" type="number" min="0" step="0.01" placeholder="0.00" />
            </div>

            {staff.length > 0 && (
              <label className="block text-sm text-white/70">
                Staff member
                <select
                  name="staff_id"
                  className="mt-1 w-full rounded-lg border border-white/10 bg-dark-100 px-3 py-2 text-sm text-white"
                  defaultValue=""
                >
                  <option value="">Not attributed</option>
                  {staff.map((s) => (
                    <option key={s.id} value={s.id}>{s.display_name}</option>
                  ))}
                </select>
              </label>
            )}

            <Input label="Customer email (receipt, optional)" name="customer_email" type="email" placeholder="customer@example.com" />

            <div>
              <p className="mb-1.5 text-sm text-white/70">Payment</p>
              <div className="flex flex-wrap gap-2">
                {TENDERS.map((t) => (
                  <button
                    key={t.value}
                    type="button"
                    onClick={() => setTender(t.value)}
                    className={`tap-target flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      tender === t.value ? "border-gold text-gold" : "border-white/10 text-white/60 hover:text-white"
                    }`}
                  >
                    <t.icon className="h-4 w-4" /> {t.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between border-t border-white/10 pt-3">
              <span className="text-sm text-white/60">Subtotal</span>
              <span className="text-lg font-semibold text-white">{formatPence(subtotalPence)}</span>
            </div>

            {actionData && "error" in actionData && (
              <p className="text-sm text-red-400" role="alert">{actionData.error}</p>
            )}

            <Button type="submit" className="w-full" disabled={isSubmitting || cart.length === 0}>
              {isSubmitting
                ? "Processing…"
                : tender === "stripe"
                  ? "Create payment QR →"
                  : "Complete sale →"}
            </Button>
          </Form>
        </div>
      )}
    </div>
  );
}

// ─── Post-sale panel: receipt or live QR payment ──────────────────────────────

function SaleResultPanel({
  sale,
  shopId,
  canVoid,
  isSubmitting,
  onNewSale,
}: {
  sale: PosSaleResult;
  shopId: string | null;
  canVoid: boolean;
  isSubmitting: boolean;
  onNewSale: () => void;
}) {
  const poll = useFetcher<{ success: boolean; data?: { status: string } }>();
  const [status, setStatus] = useState(sale.status);

  // A pending Stripe sale settles via webhook — poll until it flips.
  useEffect(() => {
    if (sale.tender_type !== "stripe" || status !== "pending" || !shopId) return;
    const t = setInterval(() => {
      if (poll.state === "idle") {
        poll.load(`/api/shops/${shopId}/sales/${sale.id}`);
      }
    }, 3000);
    return () => clearInterval(t);
  }, [sale, status, shopId, poll]);

  useEffect(() => {
    const next = poll.data?.data?.status;
    if (next && next !== status) setStatus(next);
  }, [poll.data, status]);

  const paid = status === "completed";
  const voided = status === "voided";

  return (
    <div className="max-w-xl space-y-4 rounded-xl border border-white/10 bg-dark-100 p-6">
      <div className="flex items-center justify-between">
        <h2 className="font-heading text-lg font-bold text-white">
          {voided ? "Sale voided" : paid ? "Sale complete" : "Awaiting payment"}
        </h2>
        <span
          className={`rounded-full px-3 py-1 text-xs font-semibold ${
            paid
              ? "bg-emerald-500/15 text-emerald-400"
              : voided
                ? "bg-red-500/15 text-red-400"
                : "bg-amber-500/15 text-amber-300"
          }`}
        >
          {status}
        </span>
      </div>

      <dl className="space-y-1 text-sm">
        <Row label="Subtotal" value={formatPence(sale.subtotal_pence)} />
        {sale.discount_pence > 0 && <Row label="Discount" value={`−${formatPence(sale.discount_pence)}`} />}
        {sale.tip_pence > 0 && <Row label="Tip" value={formatPence(sale.tip_pence)} />}
        {sale.commission_pence > 0 && <Row label="Service fee" value={formatPence(sale.commission_pence)} />}
        <div className="flex items-center justify-between border-t border-white/10 pt-2">
          <dt className="text-white/60">Total</dt>
          <dd className="text-xl font-bold text-gold">{formatPence(sale.total_pence)}</dd>
        </div>
      </dl>

      {sale.tender_type === "stripe" && sale.payment_url && !paid && !voided && (
        <div className="space-y-3 rounded-lg bg-white p-4 text-center">
          <div className="mx-auto w-fit">
            <QRCode value={sale.payment_url} size={180} />
          </div>
          <p className="text-xs text-neutral-600">
            Ask the customer to scan and pay on their phone. This screen updates when payment lands.
          </p>
          <a href={sale.payment_url} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-700 underline">
            Or open the payment page on this device
          </a>
        </div>
      )}

      <div className="flex gap-2">
        <Button type="button" className="flex-1" onClick={onNewSale}>
          New sale
        </Button>
        {canVoid && !voided && !(sale.tender_type === "stripe" && paid) && (
          <Form method="post" className="flex-1">
            <input type="hidden" name="intent" value="void" />
            <input type="hidden" name="saleId" value={sale.id} />
            {shopId && <input type="hidden" name="shopId" value={shopId} />}
            <Button type="submit" variant="outline" className="w-full" disabled={isSubmitting}>
              {isSubmitting ? "Voiding…" : "Void sale"}
            </Button>
          </Form>
        )}
      </div>
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
