// apps/web/app/routes/$shopSlug.walkin.tsx
// Customer-facing walk-in queue page

import { useState, useEffect } from "react";
import { useParams } from "@remix-run/react";
import type { MetaFunction, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { isPortfolioDemoShop } from "@repo/utils";
import { requireShopSlug } from "~/lib/shopSlug";

export const meta: MetaFunction = () => [{ title: "Join the Queue | Pivot Parlor" }];

export function loader({ params }: LoaderFunctionArgs) {
  const slug = requireShopSlug(params);
  return isPortfolioDemoShop(slug) ? redirect(`/${slug}/book`) : json({});
}

type Step = "form" | "waiting" | "serving" | "done";

interface QueueEntry {
  id: string;
  position: number;
  status: string;
  ahead: number;
  est_wait_minutes: number;
  name: string;
}

export default function WalkIn() {
  const { shopSlug } = useParams();
  const [step, setStep] = useState<Step>("form");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [service, setService] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [entry, setEntry] = useState<QueueEntry | null>(null);
  const [shopName, setShopName] = useState("");

  // Poll queue status every 30s once joined
  useEffect(() => {
    if (!entry?.id || step === "done") return;
    const poll = async () => {
      try {
        // Same-origin proxy routes (api.walkin.*): the site's own API for every environment.
        const res = await fetch(`/api/walkin/${shopSlug}/status/${entry.id}`);
        const data = await res.json() as { success: boolean; data?: QueueEntry };
        if (data.success && data.data) {
          setEntry(data.data);
          if (data.data.status === "serving") setStep("serving");
          if (data.data.status === "served") setStep("done");
        }
      } catch { /* non-fatal */ }
    };
    poll();
    const interval = setInterval(poll, 30_000);
    return () => clearInterval(interval);
  }, [entry?.id, shopSlug, step]);

  async function joinQueue() {
    if (!name.trim()) { setError("Please enter your name."); return; }
    setSubmitting(true); setError("");
    try {
      const res = await fetch(`/api/walkin/${shopSlug}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), phone: phone.trim() || undefined, service: service.trim() || undefined }),
      });
      const data = await res.json() as { success: boolean; data?: { id: string; position: number; shop_name: string }; error?: string };
      if (data.success && data.data) {
        setEntry({ id: data.data.id, position: data.data.position, status: "waiting", ahead: data.data.position - 1, est_wait_minutes: (data.data.position - 1) * 20, name: name.trim() });
        setShopName(data.data.shop_name);
        setStep("waiting");
      } else {
        setError(data.error ?? "Failed to join queue. Please try again.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-dark flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="text-center mb-8">
          <p className="text-xs font-semibold text-white/50 uppercase tracking-widest mb-1">Walk-in</p>
          <h1 className="font-heading text-2xl font-bold text-white">{shopName || "Join the Queue"}</h1>
        </div>

        {/* Form */}
        {step === "form" && (
          <div className="rounded-2xl border border-white/10 bg-dark-100 p-6 space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Your name <span className="text-gold">*</span></label>
              <input type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder="Jane Smith"
                className="w-full rounded-lg border border-white/40 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Phone (optional)</label>
              <input type="tel" value={phone} onChange={e => setPhone(e.target.value)}
                placeholder="+44 7700 900000"
                className="w-full rounded-lg border border-white/40 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>
            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Service (optional)</label>
              <input type="text" value={service} onChange={e => setService(e.target.value)}
                placeholder="e.g. Haircut, Beard trim…"
                className="w-full rounded-lg border border-white/40 bg-white/5 px-3 py-2.5 text-sm text-white placeholder:text-white/60 focus:outline-none focus:ring-2 focus:ring-gold" />
            </div>
            {error && <p className="text-sm text-red-400">{error}</p>}
            <button onClick={joinQueue} disabled={submitting}
              className="w-full py-3 rounded-xl bg-gold text-dark font-bold text-sm hover:bg-gold/90 transition-colors disabled:opacity-60">
              {submitting ? "Joining…" : "Join the queue →"}
            </button>
            <p className="text-center text-xs text-white/50">
              We use these details only to manage your place in the queue. See
              our{" "}
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

        {/* Waiting */}
        {step === "waiting" && entry && (
          <div className="rounded-2xl border border-white/10 bg-dark-100 overflow-hidden">
            <div className="bg-gold/10 border-b border-gold/20 px-6 py-5 text-center">
              <p className="text-xs font-semibold text-gold/70 uppercase tracking-wider mb-1">Your queue position</p>
              <p className="text-6xl font-bold text-gold">{entry.position}</p>
            </div>
            <div className="px-6 py-5 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-white/60">Name</span>
                <span className="text-white font-medium">{entry.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/60">People ahead</span>
                <span className="text-white font-medium">{entry.ahead}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-white/60">Est. wait</span>
                <span className="text-white font-medium">
                  {entry.est_wait_minutes === 0 ? "You're next!" : `~${entry.est_wait_minutes} min`}
                </span>
              </div>
            </div>
            <div className="px-6 pb-5">
              <p className="text-center text-xs text-white/50">This page updates automatically every 30 seconds.</p>
            </div>
          </div>
        )}

        {/* Being served */}
        {step === "serving" && (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
            <div className="text-5xl mb-4">💈</div>
            <h2 className="font-heading text-xl font-bold text-white">It&apos;s your turn!</h2>
            <p className="text-sm text-white/60 mt-2">Please make your way to the counter.</p>
          </div>
        )}

        {/* Done */}
        {step === "done" && (
          <div className="rounded-2xl border border-white/10 bg-dark-100 p-8 text-center">
            <div className="text-5xl mb-4">✅</div>
            <h2 className="font-heading text-xl font-bold text-white">Thanks for visiting!</h2>
            <p className="text-sm text-white/60 mt-2">We hope to see you again soon.</p>
          </div>
        )}

      </div>
    </div>
  );
}
