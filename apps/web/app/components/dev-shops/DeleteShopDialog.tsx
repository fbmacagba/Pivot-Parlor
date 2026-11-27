// The one delete-shop confirmation, used by the shops list and the shop's own
// page. Covered by tests/e2e/dev-dashboard.spec.ts (delete lifecycle).
import { useEffect, useState } from "react";
import { useFetcher } from "react-router";
import { formatPence } from "@repo/utils";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { useFetcherResult } from "~/lib/useFetcherResult";
import type { Shop } from "./types";

export interface DeleteShopResult {
  success?: boolean;
  error?: string;
  deletedShopId?: string;
  data?: { id?: string };
}

type DeletableShop = Pick<Shop, "id" | "name" | "slug"> &
  Partial<Pick<Shop, "booking_count" | "commission_total_pence" | "website_status" | "has_site">>;

export function DeleteShopDialog({
  shop,
  onClose,
  onDeleted,
}: {
  /** The shop to delete, or null while the dialog is closed. */
  shop: DeletableShop | null;
  onClose: () => void;
  /** Runs once the shop is gone, before the dialog closes. */
  onDeleted?: (shopId: string) => void;
}) {
  const fetcher = useFetcher<DeleteShopResult>();
  const [error, setError] = useState<string | null>(null);
  const shopId = shop?.id ?? null;

  // An error belongs to one attempt on one shop, never to the next shop opened.
  useEffect(() => {
    setError(null);
  }, [shopId]);

  useFetcherResult(fetcher, (result) => {
    if (result.success) {
      setError(null);
      if (shopId) onDeleted?.(shopId);
      onClose();
    } else {
      setError(result.error?.trim() || "The shop could not be deleted. Nothing was removed. Please try again.");
    }
  });

  const live = shop?.has_site && (shop.website_status ?? "").toLowerCase() === "live";
  const bookings = shop?.booking_count;

  return (
    <ConfirmDialog
      open={shop !== null}
      onCancel={() => {
        setError(null);
        onClose();
      }}
      onConfirm={() => {
        if (!shop) return;
        setError(null);
        fetcher.submit({}, { method: "post", action: `/api/shops/${encodeURIComponent(shop.id)}/delete` });
      }}
      title={shop ? `Delete ${shop.name}?` : "Delete shop?"}
      confirmLabel="Delete shop"
      pendingLabel="Deleting…"
      destructive
      pending={fetcher.state !== "idle"}
      error={error}
      typeToConfirm={shop?.slug}
    >
      {shop && (
        <>
          <p>
            This permanently deletes <span className="font-medium text-white">{shop.name}</span> (
            <code data-testid="delete-shop-slug" className="text-white">
              {shop.slug}
            </code>
            ): the shop, its site, staff accounts, services, bookings and history.
          </p>
          {(live || typeof bookings === "number") && (
            <ul className="list-disc space-y-1 pl-5">
              {live && <li>Its site is live now and will go offline at once.</li>}
              {typeof bookings === "number" && (
                <li>
                  {bookings === 0
                    ? "It has no bookings."
                    : `${bookings} ${bookings === 1 ? "booking" : "bookings"} will be deleted` +
                      (shop.commission_total_pence
                        ? `, with ${formatPence(shop.commission_total_pence)} of commission history.`
                        : ".")}
                </li>
              )}
            </ul>
          )}
          <p className="font-medium text-white">This cannot be undone.</p>
        </>
      )}
    </ConfirmDialog>
  );
}
