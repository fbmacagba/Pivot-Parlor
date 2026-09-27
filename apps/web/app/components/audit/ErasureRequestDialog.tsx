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
// route action (Form method="post", intent=erase), so this dialog is
// closed/errored by the PARENT reading its own `useNavigation()`/
// `useActionData()` once the submission settles (see dev.activity.tsx) and
// passing that down as `error`/`busy` — not by a fetcher this dialog
// doesn't have.
//
// Fix round 2 re-review (progress.md, Ruling 51 follow-up — CRITICAL
// regression): the confirm button used to carry `onClick={onClose}`
// alongside `type="submit"`. That immediately set the state that gates
// this dialog's own conditional render, unmounting the <form> the button
// was inside of, before the browser's native "submit" step could run on
// it — a real Chrome + React 18.3.1 browser cancels that submission ("Form
// submission canceled because the form is not connected") and `onSubmit`
// never fires, so the erase action was silently unreachable from the UI.
// The submit button now carries NO onClick at all — closing happens only
// from the outcome, driven by the parent.
import { Loader2 } from "lucide-react";
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
  error = null,
}: {
  target: ErasureTarget | null;
  onClose: () => void;
  /** True while the erase submission is in flight (the parent's
   *  `useNavigation()` gated to this dialog's own submission); disables
   *  the confirm button so it can't be double-submitted. */
  busy?: boolean;
  /** Set by the parent once a submission made from THIS dialog settles
   *  with an error — kept open and shown here (DeleteShopDialog's own
   *  pattern) rather than silently closing on failure. */
  error?: string | null;
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
            {error && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {error}
              </div>
            )}
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
                >
                  {busy ? (
                    <>
                      <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                      Recording…
                    </>
                  ) : (
                    "Confirm erasure request"
                  )}
                </Button>
              </Form>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
