import { useFetcher } from "react-router";
import { useId, useState } from "react";
import { Button } from "~/components/ui/Button";
import { FIELD_LABEL } from "~/components/ui/fieldStyles";
import { REFUND_EVIDENCE_ACCEPT, refundEvidenceProblem } from "~/lib/refundRequests";

type Answer = { ok: true; message: string } | { error: string };

/**
 * Attach an evidence file to a refund request that is still waiting and has
 * none. Posts `intent=add_evidence` to the page's own action. It can be done
 * once: after that the request shows its evidence and this is not rendered.
 */
export function AddEvidence({ shopId, requestId }: { shopId: string | null; requestId: string }) {
  const fetcher = useFetcher<Answer>();
  const [file, setFile] = useState<File | null>(null);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const busy = fetcher.state !== "idle";
  const fileProblem = refundEvidenceProblem(file);
  const failed = !busy && fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;

  return (
    <form
      className="mt-3 flex flex-col gap-1.5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!file || fileProblem) return;
        const form = new FormData();
        if (shopId) form.append("shopId", shopId);
        form.append("intent", "add_evidence");
        form.append("requestId", requestId);
        form.append("evidence", file, file.name);
        fetcher.submit(form, { method: "post", encType: "multipart/form-data" });
      }}
    >
      <label htmlFor={inputId} className={FIELD_LABEL}>
        Add evidence
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="file"
          name="evidence"
          accept={REFUND_EVIDENCE_ACCEPT}
          disabled={busy}
          aria-describedby={hintId}
          aria-invalid={fileProblem ? true : undefined}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="tap-target block min-w-0 flex-1 text-sm text-white/70 file:mr-3 file:rounded-lg file:border file:border-white/10 file:bg-dark-200 file:px-3 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-dark-300"
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !file || Boolean(fileProblem)}>
          {busy ? "Attaching…" : "Attach"}
        </Button>
      </div>
      <p id={hintId} className={fileProblem ? "text-xs text-red-400" : "text-xs text-white/60"}>
        {fileProblem ?? "Image or PDF, up to 5MB. A file can be added once and cannot be changed afterwards."}
      </p>
      {failed && (
        <p role="alert" className="text-xs text-red-400">
          {failed}
        </p>
      )}
    </form>
  );
}
