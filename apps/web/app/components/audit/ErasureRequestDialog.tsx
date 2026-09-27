// Erasure-request confirmation dialog for the developer Activity page.
// Ruling 51: scheduling a subject's personal-detail blanking is a
// one-click, hard-to-undo action, so it needs the same explicit
// confirmation step DeleteShopDialog gives shop deletion — a modal that
// states, in plain words, who the request is for, what happens (personal
// details blanked in 30 days), and that the request itself is recorded.
//
// One deliberate difference from DeleteShopDialog's shape: DeleteShopDialog
// submits through its own `useFetcher` straight to a resource route, so it
// can show a fetcher-scoped loading/error state inside the dialog. The
// Activity page's erase intent instead goes through dev.activity.tsx's own
// route action (Form method="post", intent=erase) so the existing
// post-erase banner (useActionData's `result.erased`/`result.error`,
// already rendered above the list) keeps working unchanged. The confirm
// button here is a native submit button inside that same Form; clicking it
// both submits and closes the dialog immediately, and the page's existing
// banner reports the outcome once the action resolves — there is no
// separate in-dialog error/loading state to keep in sync with a fetcher
// this dialog doesn't have.
import { Form } from "@remix-run/react";
import { Button } from "~/components/ui/Button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "~/components/ui/Dialog";

export interface ErasureTarget {
  /** The bare user id (already stripped of the "subj_user_" prefix) the
   *  route's `/subjects/:userId/erase` expects. */
  userId: string;
  /** Plain-language identifier for the person — the same `who` label the
   *  entry row already shows (a name, an email, or a role fallback). */
  who: string;
}

export function ErasureRequestDialog({
  target,
  onClose,
  busy = false,
}: {
  target: ErasureTarget | null;
  onClose: () => void;
  /** True while any request on the page is in flight (mirrors the page's
   *  own `useNavigation()` gate on its other buttons); disables the
   *  confirm button so it can't be double-submitted. */
  busy?: boolean;
}) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record erasure request</DialogTitle>
        </DialogHeader>
        {target && (
          <>
            <p className="text-sm text-white/70">
              This will record a request to erase{" "}
              <span className="font-medium text-white">{target.who}</span>&apos;s personal
              details. Their name, email and IP address will be permanently blanked in 30
              days. Recording this request is itself added to the activity trail, and it
              cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Form method="post">
                <input type="hidden" name="intent" value="erase" />
                <input type="hidden" name="user_id" value={target.userId} />
                <Button
                  type="submit"
                  size="sm"
                  className="bg-red-600 hover:bg-red-500"
                  disabled={busy}
                  onClick={onClose}
                >
                  Confirm erasure request
                </Button>
              </Form>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
