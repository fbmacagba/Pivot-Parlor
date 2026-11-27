import { useEffect, useState } from "react";
import type { useFetcher } from "react-router";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/Dialog";
import { useFetcherResult } from "~/lib/useFetcherResult";
import type { Shop } from "./types";

export type RatesActionResult = { success: boolean; ratesUpdated?: boolean; error?: string | null };

/**
 * Developer-only commission editor (WS-3): the platform's cut on the service
 * portion vs the retail (product) portion of every sale. The worker rejects
 * rate changes from non-developer roles.
 */
export function RatesDialog({
  shop,
  onClose,
  fetcher,
}: {
  shop: Shop | null;
  onClose: () => void;
  fetcher: ReturnType<typeof useFetcher<RatesActionResult>>;
}) {
  const submitting = fetcher.state !== "idle";
  const [error, setError] = useState<string | null>(null);
  const shopId = shop?.id ?? null;

  // The fetcher keeps its last answer; an error shown here belongs to one
  // attempt on one shop only.
  useEffect(() => {
    setError(null);
  }, [shopId]);

  // Closes once per finished save, so reopening for another shop stays open.
  useFetcherResult(fetcher, (result) => {
    if (result.ratesUpdated) {
      setError(null);
      onClose();
    } else {
      setError(result.error?.trim() || "The rates could not be saved. Please try again.");
    }
  });

  return (
    <Dialog
      open={shop !== null}
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Commission rates: {shop?.name}</DialogTitle>
        </DialogHeader>
        {shop && (
          <fetcher.Form method="post" action="/dev/shops?index" className="space-y-4" onSubmit={() => setError(null)}>
            <input type="hidden" name="_action" value="update-rates" />
            <input type="hidden" name="shopId" value={shop.id} />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Input
                label="Services (%)"
                name="commission_percent"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.1"
                defaultValue={((shop.commission_rate ?? 0.1) * 100).toFixed(1)}
                required
              />
              <Input
                label="Retail products (%)"
                name="retail_commission_percent"
                type="number"
                inputMode="decimal"
                min="0"
                max="100"
                step="0.1"
                defaultValue={((shop.retail_commission_rate ?? shop.commission_rate ?? 0.1) * 100).toFixed(1)}
                required
              />
            </div>
            <p className="text-xs text-white/60">
              Applied to new sales only; the ledger keeps the rate each sale was made at.
              Tips are never commissioned.
            </p>
            {error && (
              <p className="text-sm text-red-400" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Saving…" : "Save rates"}
            </Button>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
