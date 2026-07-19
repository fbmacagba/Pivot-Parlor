// apps/web/app/components/ReviewModal.tsx
import { useId, useState } from "react";
import { useModalA11y } from "~/lib/useModalA11y";

interface ReviewModalProps {
  shopId: string;
  shopName: string;
  /** Shop slug for the point-of-collection privacy link (shop = controller). */
  shopSlug: string;
  bookingId: string | null;
  customerName?: string;
  onClose: () => void;
}

function StarPicker({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [hovered, setHovered] = useState(0);
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onMouseEnter={() => setHovered(n)}
          onMouseLeave={() => setHovered(0)}
          onClick={() => onChange(n)}
          className="rounded text-3xl outline-none transition-transform hover:scale-110 focus-visible:ring-2 focus-visible:ring-gold focus-visible:ring-offset-2 focus-visible:ring-offset-dark-100"
          aria-label={`${n} star${n !== 1 ? "s" : ""}`}
        >
          <span className={(hovered || value) >= n ? "text-gold" : "text-white/40"}>
            ★
          </span>
        </button>
      ))}
    </div>
  );
}

export function ReviewModal({ shopId, shopName, shopSlug, bookingId, customerName, onClose }: ReviewModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const nameId = `${id}-name`;
  const bodyId = `${id}-body`;

  const [name, setName] = useState(customerName ?? "");
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  // Focus trap, focus-in, Escape-to-close, scroll-lock and focus-restore.
  const dialogRef = useModalA11y<HTMLDivElement>({ active: true, onClose });

  async function submit() {
    if (!name.trim()) {
      setErrorMsg("Please enter your name.");
      return;
    }
    if (rating === 0) {
      setErrorMsg("Please select a rating.");
      return;
    }
    if (!body.trim()) {
      setErrorMsg("Please write a short review.");
      return;
    }
    setErrorMsg("");
    setState("submitting");

    try {
      const res = await fetch(`/api/shops/${shopId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          customer_name: name.trim(),
          rating,
          body: body.trim(),
          booking_id: bookingId,
        }),
      });
      const data = await res.json() as { success: boolean; error?: string };
      if (data.success) {
        setState("success");
      } else {
        setErrorMsg(data.error ?? "Something went wrong. Please try again.");
        setState("error");
      }
    } catch {
      setErrorMsg("Network error. Please try again.");
      setState("error");
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        role="presentation"
        className="fixed inset-0 z-50 cursor-pointer bg-black/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="fixed inset-x-4 top-1/2 z-[51] mx-auto max-h-[90vh] max-w-md -translate-y-1/2 overflow-hidden overflow-y-auto rounded-2xl border border-white/10 bg-dark-100 shadow-2xl focus:outline-none"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/10 px-6 py-5">
          <div>
            <h2 id={titleId} className="text-base font-semibold text-white">
              Leave a review
            </h2>
            <p className="mt-0.5 text-xs text-white/60">{shopName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 min-h-[40px] w-10 min-w-[40px] items-center justify-center rounded-lg outline-none text-white/50 transition-colors hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-gold"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {state === "success" ? (
          <div className="px-6 py-10 text-center">
            <div className="mb-4 text-5xl" aria-hidden>
              ⭐
            </div>
            <h3 className="text-lg font-semibold text-white">Thank you!</h3>
            <p className="mt-2 text-sm text-white/50">Your review has been submitted.</p>
            <button
              type="button"
              onClick={onClose}
              className="mt-6 rounded-lg bg-gold px-6 py-2.5 text-sm font-semibold text-dark outline-none transition-colors hover:bg-gold-light focus-visible:ring-2 focus-visible:ring-gold-light focus-visible:ring-offset-2 focus-visible:ring-offset-dark-100"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="space-y-5 px-6 py-5">
            {/* Name */}
            <div>
              <label htmlFor={nameId} className="mb-1.5 block text-sm font-medium text-white/80">
                Your name
              </label>
              <input
                id={nameId}
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                autoComplete="name"
                className="w-full rounded-lg border border-white/40 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/60 focus:ring-2 focus:ring-gold/70"
              />
            </div>

            {/* Star rating */}
            <div>
              <span className="mb-2 block text-sm font-medium text-white/80">Rating</span>
              <StarPicker value={rating} onChange={setRating} />
              {rating > 0 && (
                <p className="mt-1 text-xs text-white/60">
                  {["", "Poor", "Fair", "Good", "Great", "Excellent"][rating]}
                </p>
              )}
            </div>

            {/* Review text */}
            <div>
              <label htmlFor={bodyId} className="mb-1.5 block text-sm font-medium text-white/80">
                Your review
              </label>
              <textarea
                id={bodyId}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Tell others about your experience..."
                className="w-full resize-none rounded-lg border border-white/40 bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-white/60 focus:ring-2 focus:ring-gold/70"
              />
            </div>

            {/* Error */}
            {(state === "error" || errorMsg) && (
              <p role="alert" className="text-sm text-red-400">
                {errorMsg}
              </p>
            )}

            {/* Submit */}
            <button
              type="button"
              onClick={() => void submit()}
              disabled={state === "submitting"}
              className="w-full rounded-lg bg-gold py-3 text-sm font-semibold text-dark outline-none transition-colors hover:bg-gold-light focus-visible:ring-2 focus-visible:ring-gold-light focus-visible:ring-offset-2 focus-visible:ring-offset-dark-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {state === "submitting" ? "Submitting..." : "Submit review"}
            </button>

            {/* Point-of-collection notice (LEG-3): reviews are public. */}
            <p className="text-center text-xs text-white/60">
              Your name, rating and review will be shown publicly on{" "}
              {shopName}&apos;s page. See our{" "}
              <a
                href={`/${shopSlug}/privacy`}
                className="underline hover:text-white/80"
              >
                Privacy Policy
              </a>
              .
            </p>
          </div>
        )}
      </div>
    </>
  );
}
