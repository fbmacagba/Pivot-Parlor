import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { ArrowRight } from "lucide-react";
import { platformNoticeAnswered } from "~/components/PlatformCookieBanner";
import { useCookieNoticeOpen } from "~/lib/cookieNoticeLayer";

const HIDDEN_PATHS = ["/contact", "/login"];

export function FloatingCTA() {
  const { pathname } = useLocation();
  // It waits for the cookie notice: lifted above the floating cookie card it
  // covered the hero's own sign-up button, which does the same job (as does
  // the navbar's). Not in the server's HTML, and shown only once the notice
  // is known to be answered: the notice appears after hydration, so a button
  // shown until then would flash and vanish on a first visit.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const cookieNoticeOpen = useCookieNoticeOpen();

  if (!mounted || cookieNoticeOpen || !platformNoticeAnswered()) return null;
  if (HIDDEN_PATHS.some((p) => pathname.startsWith(p))) return null;

  return (
    // On a phone the words are display:none and name nothing, so the link
    // carries its name itself.
    <Link
      to="/contact"
      aria-label="Get your shop on Pivot"
      className="fixed bottom-6 left-6 z-40 flex items-center gap-2 rounded-full bg-gold px-5 py-3 text-sm font-semibold text-dark shadow-lg shadow-gold/25 transition-all hover:bg-gold-light hover:scale-105 active:scale-95 sm:px-6"
    >
      <span className="hidden sm:inline">Get your shop on Pivot</span>
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}
