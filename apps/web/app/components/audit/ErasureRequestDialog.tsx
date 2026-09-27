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
//
// Fix round 3 (progress.md, Ruling 52 — Important race): closing on the
// outcome (round 2's fix) opened a narrower race — while subject A's
// erase was in flight, Cancel/Escape/overlay-click could still dismiss
// A's dialog, letting the developer open a dialog for subject B before A
// settled; A's outcome would then land on B's now-open dialog. Fixed here
// by refusing to dismiss the dialog AT ALL while its own erase is in
// flight (Cancel disabled below; `onOpenChange` below is a no-op while
// `busy`), so there is no longer a way to have a different dialog open
// when a stale outcome arrives. The parent (dev.activity.tsx) also now
// tracks the in-flight submission's user_id and only applies an outcome
// to a dialog whose open target still matches it, as defense in depth.
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
  /** True only while the in-flight navigation is specifically an erase
   *  submission FOR THIS DIALOG'S OWN OPEN TARGET (the parent scopes its
   *  `useNavigation()` state to intent === "erase" AND a matching
   *  user_id) — not simply `nav.state !== "idle"`, which would also be
   *  true during an unrelated verify/import submission elsewhere on the
   *  page. Disables the confirm button so it can't be double-submitted,
   *  disables Cancel, and makes Escape/overlay-click a no-op (Ruling 52):
   *  the dialog cannot be dismissed while its own request is in flight, so
   *  a stale outcome can never land on a dialog open for a different
   *  subject. */
  busy?: boolean;
  /** Set by the parent once a submission made from THIS dialog settles
   *  with an error — kept open and shown here (DeleteShopDialog's own
   *  pattern) rather than silently closing on failure. */
  error?: string | null;
}) {
  return (
    <Dialog
      open={target !== null}
      onOpenChange={(open) => {
        // Ruling 52: while this dialog's own erase is in flight, ignore
        // every dismiss path (Escape, overlay-click, or Radix's own
        // programmatic close) — only a settled outcome, or Cancel once
        // busy clears, may close it.
        if (busy) return;
        if (!open) onClose();
      }}
    >
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
              <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
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
