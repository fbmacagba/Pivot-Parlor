import { parsePoundsToPence } from "@repo/utils";

export interface PosTotals {
  /** null when the field holds something that is not a pounds amount. */
  discountPence: number | null;
  tipPence: number | null;
  /** What the till shows as the amount to collect. null while a field is unreadable or the discount is too large. */
  totalPence: number | null;
  discountError?: string;
  tipError?: string;
}

const NOT_AN_AMOUNT = "Enter an amount in pounds, like 2.50.";

/**
 * The amount to collect, as the sales API works it out (the booking worker's
 * POST /:shopId/sales): subtotal, less the discount, plus the tip, in whole
 * pence. An empty field is zero. The fields are read exactly as the page's
 * action reads them (parsePoundsToPence), so the figure on screen is the
 * figure sent. The API refuses a discount above the subtotal, and so does
 * this.
 *
 * One thing the till cannot know: a shop that passes the platform's service
 * fee to the customer has it added by the API, and the receipt shows it.
 */
export function posTotals(subtotalPence: number, discountInput: string, tipInput: string): PosTotals {
  const read = (input: string) => (input.trim() === "" ? 0 : parsePoundsToPence(input));
  const discountPence = read(discountInput);
  const tipPence = read(tipInput);

  const discountError =
    discountPence === null
      ? NOT_AN_AMOUNT
      : discountPence > subtotalPence
        ? "The discount cannot be more than the subtotal."
        : undefined;
  const tipError = tipPence === null ? NOT_AN_AMOUNT : undefined;

  const totalPence =
    discountPence === null || tipPence === null || discountError ? null : subtotalPence - discountPence + tipPence;

  return { discountPence, tipPence, totalPence, discountError, tipError };
}
