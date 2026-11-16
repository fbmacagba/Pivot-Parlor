import { Link, useLocation } from "react-router";
import { ArrowRight } from "lucide-react";
import { ABOVE_COOKIE_NOTICE } from "~/lib/cookieNoticeLayer";

const HIDDEN_PATHS = ["/contact", "/login"];

export function FloatingCTA() {
  const { pathname } = useLocation();

  if (HIDDEN_PATHS.some((p) => pathname.startsWith(p))) return null;

  return (
    // On a phone the words are display:none and name nothing, so the link
    // carries its name itself. It rides above an open cookie notice.
    <Link
      to="/contact"
      aria-label="Get your shop on Pivot"
      className={`fixed ${ABOVE_COOKIE_NOTICE.bottom6} left-6 z-40 flex items-center gap-2 rounded-full bg-gold px-5 py-3 text-sm font-semibold text-dark shadow-lg shadow-gold/25 transition-all hover:bg-gold-light hover:scale-105 active:scale-95 sm:px-6`}
    >
      <span className="hidden sm:inline">Get your shop on Pivot</span>
      <ArrowRight className="h-4 w-4" />
    </Link>
  );
}
