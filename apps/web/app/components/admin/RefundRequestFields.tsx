import { useId } from "react";
import { Textarea } from "~/components/ui/Textarea";
import { FIELD_LABEL } from "~/components/ui/fieldStyles";
import {
  REFUND_EVIDENCE_ACCEPT,
  REFUND_REASON_MAX,
  refundEvidenceProblem,
} from "~/lib/refundRequests";

interface RefundRequestFieldsProps {
  reason: string;
  onReasonChange: (value: string) => void;
  /** Shown under the reason once the person has tried to send it. */
  reasonError?: string | null;
  file: File | null;
  onFileChange: (file: File | null) => void;
  disabled?: boolean;
  /** The person filing can also approve (an owner): say what evidence buys. */
  canApprove?: boolean;
}

/**
 * The two things a refund request carries: why the refund is due (required)
 * and a file that backs it up (optional). The fields are named `reason` and
 * `evidence`, so a plain form posts them as they are.
 */
export function RefundRequestFields({
  reason,
  onReasonChange,
  reasonError,
  file,
  onFileChange,
  disabled,
  canApprove,
}: RefundRequestFieldsProps) {
  const fileId = useId();
  const fileHintId = `${fileId}-hint`;
  const fileProblem = refundEvidenceProblem(file);

  return (
    <div className="space-y-3">
      <Textarea
        label="Why is this refund due?"
        name="reason"
        rows={3}
        required
        maxLength={REFUND_REASON_MAX}
        placeholder="What happened, and when. For example: customer rang on Tuesday to cancel, three days ahead."
        value={reason}
        onChange={(e) => onReasonChange(e.target.value)}
        error={reasonError ?? undefined}
        disabled={disabled}
      />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fileId} className={FIELD_LABEL}>
          Evidence (optional)
        </label>
        <input
          id={fileId}
          type="file"
          name="evidence"
          accept={REFUND_EVIDENCE_ACCEPT}
          disabled={disabled}
          aria-describedby={fileHintId}
          aria-invalid={fileProblem ? true : undefined}
          onChange={(e) => onFileChange(e.target.files?.[0] ?? null)}
          className="tap-target block w-full text-sm text-white/70 file:mr-3 file:rounded-lg file:border file:border-white/10 file:bg-dark-200 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-dark-300"
        />
        <p id={fileHintId} className={fileProblem ? "text-xs text-red-400" : "text-xs text-white/60"}>
          {fileProblem ??
            `A photo, a screenshot of the message, or a receipt. Image or PDF, up to 5MB.${
              canApprove ? " Without one, you cannot approve this request yourself." : ""
            }`}
        </p>
      </div>
    </div>
  );
}
