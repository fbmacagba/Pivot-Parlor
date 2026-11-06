/** Two-letter monogram for a shop without a logo. Words only: "Linden & Lark"
 *  is "LL", not "L&". */
export function shopNameInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => /\p{L}|\p{N}/u.test(p));
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ""}${parts[1]![0] ?? ""}`.toUpperCase() || "?";
}

/** True only for a service the owner filed under a retail category. Every row
 *  in the services table is a bookable appointment; the old name-keyword guess
 *  ("beard", "wax", "gel", "oil", "spray"...) hid real services such as a beard
 *  sculpt, leg wax, gel nails or a spray tan from the chat menu and put a
 *  stock "Grooming products, In-store" line in their place. */
export function isRetailCategory(category: string | null | undefined): boolean {
  return /^(products?|retail)$/i.test((category ?? "").trim());
}
