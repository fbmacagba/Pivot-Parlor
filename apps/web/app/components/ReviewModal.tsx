// apps/web/app/components/ReviewModal.tsx
import { useState } from "react";

interface ReviewModalProps {
  shopId: string;
  shopName: string;
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
          className="text-3xl transition-transform hover:scale-110 focus:outline-none"
          aria-label={`${n} star${n !== 1 ? "s" : ""}`}
        >
          <span className={(hovered || value) >= n ? "text-yellow-400" : "text-white/20"}>
            ★
          </span>
        </button>
      ))}
    </div>
  );
}

export function ReviewModal({ shopId, shopName, bookingId, customerName, onClose }: ReviewModalProps) {
  const [name, setName] = useState(customerName ?? "");
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "submitting" | "success" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");

  async function submit() {
    if (!name.trim()) { setErrorMsg("Please enter your name."); return; }
    if (rating === 0) { setErrorMsg("Please select a rating."); return; }
    if (!body.trim()) { setErrorMsg("Please write a short review."); return; }
    setErrorMsg("");
    setState("submitting");

    try {
      const res = await fetch(`/api/shops/${shopId}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customer_name: name.trim(), rating, body: body.trim(), booking_id: bookingId }),
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
      <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-50 mx-auto max-w-md rounded-2xl border border-white/10 bg-[#111] shadow-2xl overflow-hidden">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/10">
          <div>
            <h2 className="font-semibold text-white text-base">Leave a review</h2>
            <p className="text-xs text-white/40 mt-0.5">{shopName}</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/10 text-white/50 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {state === "success" ? (
          <div className="px-6 py-10 text-center">
            <div className="text-5xl mb-4">⭐</div>
            <h3 className="text-lg font-semibold text-white">Thank you!</h3>
            <p className="text-sm text-white/50 mt-2">Your review has been submitted.</p>
            <button
              onClick={onClose}
              className="mt-6 px-6 py-2.5 rounded-lg bg-yellow-400 text-black text-sm font-semibold hover:bg-yellow-300 transition-colors"
            >
              Close
            </button>
          </div>
        ) : (
          <div className="px-6 py-5 space-y-5">

            {/* Name */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Your name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-yellow-400/50"
              />
            </div>

            {/* Star rating */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-2">Rating</label>
              <StarPicker value={rating} onChange={setRating} />
              {rating > 0 && (
                <p className="text-xs text-white/40 mt-1">
                  {["", "Poor", "Fair", "Good", "Great", "Excellent"][rating]}
                </p>
              )}
            </div>

            {/* Review text */}
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Your review</label>
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder="Tell others about your experience…"
                className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2.5 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-yellow-400/50 resize-none"
              />
            </div>

            {/* Error */}
            {(state === "error" || errorMsg) && (
              <p className="text-sm text-red-400">{errorMsg}</p>
            )}

            {/* Submit */}
            <button
              onClick={submit}
              disabled={state === "submitting"}
              className="w-full py-3 rounded-lg bg-yellow-400 text-black font-semibold text-sm hover:bg-yellow-300 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {state === "submitting" ? "Submitting…" : "Submit review"}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
