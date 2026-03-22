import { Link } from "@remix-run/react";
import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/Button";

const SESSION_KEY = "pp_exit_intent_shown";

export function ExitIntentModal() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (
      typeof window === "undefined" ||
      window.innerWidth < 1024 ||
      sessionStorage.getItem(SESSION_KEY)
    ) {
      return;
    }

    const handleMouseLeave = (e: MouseEvent) => {
      if (e.clientY <= 10) {
        setVisible(true);
        sessionStorage.setItem(SESSION_KEY, "1");
        document.removeEventListener("mouseleave", handleMouseLeave);
      }
    };

    document.addEventListener("mouseleave", handleMouseLeave);
    return () => document.removeEventListener("mouseleave", handleMouseLeave);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={() => setVisible(false)}
      />
      <div className="relative z-10 w-full max-w-md rounded-2xl border border-white/10 bg-dark-100 p-8 shadow-2xl text-center">
        <button
          onClick={() => setVisible(false)}
          className="absolute right-4 top-4 rounded-full p-1 text-white/40 hover:text-white"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-4 text-4xl">✂️</div>
        <h2 className="font-heading text-2xl font-bold text-white">
          Before you go —
        </h2>
        <p className="mt-2 text-white/70">
          Get your shop&apos;s AI-branded booking page{" "}
          <strong className="text-gold">for free</strong> during our beta.
        </p>
        <p className="mt-1 text-sm text-white/50">
          No setup costs · No monthly fees · Live in 24 hours
        </p>
        <div className="mt-6 flex flex-col gap-3">
          <Button asChild size="lg" className="w-full">
            <Link to="/contact" onClick={() => setVisible(false)}>
              Get started →
            </Link>
          </Button>
          <button
            onClick={() => setVisible(false)}
            className="text-sm text-white/40 hover:text-white/60"
          >
            Maybe later
          </button>
        </div>
      </div>
    </div>
  );
}
