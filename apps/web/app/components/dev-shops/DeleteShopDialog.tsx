// Delete-shop confirmation dialog for the developer "Shops" dashboard.
// Extracted from dev.shops.tsx (T7.7 class-2) — behavior-identical; covered by
// tests/e2e/dev-dashboard.spec.ts (delete lifecycle).
import type { FetcherWithComponents } from "@remix-run/react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/Dialog";
import type { Shop } from "./types";

export interface DeleteShopResult {
  success?: boolean;
  error?: string;
  deletedShopId?: string;
  data?: { id?: string };
}

export function DeleteShopDialog({
  shop,
  onClose,
  fetcher,
}: {
  shop: Shop | null;
  onClose: () => void;
  fetcher: FetcherWithComponents<DeleteShopResult>;
}) {
  return (
    <Dialog open={shop !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete shop</DialogTitle>
        </DialogHeader>
        {shop && (
          <>
            <p className="text-sm text-white/70">
              Permanently delete{" "}
              <span className="font-medium text-white">{shop.name}</span> ({shop.slug})? This
              removes onboarding data and linked records. This cannot be undone.
            </p>
            {fetcher.data && fetcher.data.success === false && typeof fetcher.data.error === "string" ? (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {fetcher.data.error}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <fetcher.Form method="post" action={`/api/shops/${shop.id}/delete`}>
                <Button
                  type="submit"
                  size="sm"
                  className="bg-red-600 hover:bg-red-500"
                  disabled={fetcher.state !== "idle"}
                >
                  {fetcher.state !== "idle" ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      Deleting…
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-1 h-3.5 w-3.5" />
                      Delete shop
                    </>
                  )}
                </Button>
              </fetcher.Form>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
