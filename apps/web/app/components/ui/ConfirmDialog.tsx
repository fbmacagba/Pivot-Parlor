import { useEffect, useId, useState } from "react";
import { Button } from "./Button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./Dialog";
import { Input } from "./Input";

interface ConfirmDialogProps {
  open: boolean;
  /** Called when the person backs out (Cancel, Escape, the scrim, the close button). */
  onCancel: () => void;
  /** Called when they confirm. The caller submits and closes when it is done. */
  onConfirm: () => void;
  /** The question, in the product's own words: "Refund this sale?" */
  title: string;
  /** What will happen and whether it can be undone. */
  children?: React.ReactNode;
  /** Names the action: "Refund £12.00", never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Red confirm button, for anything that deletes, refunds or takes a site down. */
  destructive?: boolean;
  /** True while the action is in flight: buttons lock and the dialog stays. */
  pending?: boolean;
  pendingLabel?: string;
  /** An error from the attempt, shown in the dialog so it is not missed. */
  error?: string | null;
  /**
   * For the few actions that cannot be undone and lose data (deleting a shop):
   * the person must type this exact text before the confirm button unlocks.
   */
  typeToConfirm?: string;
}

/**
 * The one confirmation step for money, stock, live-site and delete actions.
 * Cancel takes the initial focus, so a stray Enter never confirms.
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  pendingLabel,
  error,
  typeToConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const descId = useId();
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  const locked = Boolean(typeToConfirm) && typed.trim() !== typeToConfirm;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never dismissed mid-request: the outcome must land somewhere visible.
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent aria-describedby={children ? descId : undefined} className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {children && (
            <DialogDescription id={descId} asChild>
              <div className="space-y-2 text-sm text-white/70">{children}</div>
            </DialogDescription>
          )}
        </DialogHeader>
        {typeToConfirm && (
          <div className="mb-4">
            <Input
              label={`Type ${typeToConfirm} to confirm`}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="secondary" onClick={onCancel} disabled={pending} autoFocus>
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={pending || locked}
          >
            {pending ? (pendingLabel ?? "Working…") : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
