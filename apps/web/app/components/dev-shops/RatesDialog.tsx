import { useEffect } from "react";
import type { useFetcher } from "@remix-run/react";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/Dialog";
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
  const result = fetcher.data;
  const submitting = fetcher.state !== "idle";

  useEffect(() => {
    if (shop && result?.ratesUpdated && fetcher.state === "idle") {
      onClose();
    }
  }, [shop, result, fetcher.state, onClose]);

  return (
    <Dialog open={shop !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Commission rates — {shop?.name}</DialogTitle>
        </DialogHeader>
        {shop && (
          <fetcher.Form method="post" className="space-y-4">
            <input type="hidden" name="_action" value="update-rates" />
            <input type="hidden" name="shopId" value={shop.id} />
            <div className="grid grid-cols-2 gap-3">
              <Input
                label="Services (%)"
                name="commission_percent"
                type="number"
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
            {result && !result.success && result.error && (
              <p className="text-sm text-red-400" role="alert">{result.error}</p>
            )}
            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Saving…" : "Save rates →"}
            </Button>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
