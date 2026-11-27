/**
 * Manual stock movements on the owner's Products page.
 *
 * The API takes a signed `quantity_delta`. The form used to hand the sign to
 * the owner ("Quantity (±)"), so "Waste / damage" with 3 typed in ADDED three.
 * Now the person types how many, and the movement type says which way they go.
 * Only the two types that can honestly go either way ask.
 *
 * The values are the worker's MANUAL_TYPES (apps/worker/src/routes/inventory.ts).
 * 'sale' and 'consumption' belong to the till and back-bar flows and are
 * refused there, so they are not offered here.
 */
export type MovementDirection = "add" | "remove";

export interface MovementType {
  value: "receive" | "return" | "waste" | "adjustment" | "transfer";
  label: string;
  /** Which way the stock goes, or "choose" when the person must say. */
  direction: MovementDirection | "choose";
  /** What the two choices are called for a "choose" type. */
  addLabel?: string;
  removeLabel?: string;
}

export const MOVEMENT_TYPES: readonly MovementType[] = [
  { value: "receive", label: "Delivery received (adds stock)", direction: "add" },
  { value: "return", label: "Customer return (adds stock)", direction: "add" },
  { value: "waste", label: "Waste or damage (removes stock)", direction: "remove" },
  {
    value: "adjustment",
    label: "Stock take correction",
    direction: "choose",
    addLabel: "Add: the count found more",
    removeLabel: "Remove: the count found fewer",
  },
  {
    value: "transfer",
    label: "Transfer",
    direction: "choose",
    addLabel: "Add: transferred in",
    removeLabel: "Remove: transferred out",
  },
];

export function movementType(value: string): MovementType | undefined {
  return MOVEMENT_TYPES.find((t) => t.value === value);
}

export type SignedQuantity = { ok: true; delta: number } | { ok: false; error: string };

/**
 * The signed change for a movement: `quantity` is always a positive whole
 * number, and the sign comes from the type (or, for a "choose" type, from
 * `direction`).
 */
export function signedQuantityDelta(type: string, quantity: string, direction: string): SignedQuantity {
  const known = movementType(type);
  if (!known) return { ok: false, error: "Choose what kind of stock movement this is." };

  const text = quantity.trim();
  if (!/^\d{1,7}$/.test(text) || Number(text) === 0) {
    return {
      ok: false,
      error: "Enter the quantity as a whole number above zero. The movement type decides whether it is added or removed.",
    };
  }
  const amount = Number(text);

  if (known.direction === "add") return { ok: true, delta: amount };
  if (known.direction === "remove") return { ok: true, delta: -amount };
  if (direction === "add") return { ok: true, delta: amount };
  if (direction === "remove") return { ok: true, delta: -amount };
  return { ok: false, error: "Choose whether this adds stock or removes it." };
}
