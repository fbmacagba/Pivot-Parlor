import { Link } from "@remix-run/react";

interface TemplateNavbarProps {
  shopName: string;
  shopSlug: string;
  /** Primary colour from the template (used for text/border on light navbars) */
  primaryColor?: string;
  /** Accent colour from the template */
  accentColor?: string;
  /** Dark variant — white text on a transparent/dark background */
  dark?: boolean;
}

export function TemplateNavbar({
  shopName,
  shopSlug,
  primaryColor,
  accentColor,
  dark = false,
}: TemplateNavbarProps) {
  const textColor = dark ? "rgba(255,255,255,0.9)" : (primaryColor ?? "#111111");
  const borderColor = dark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.1)";
  const btnBg = accentColor ?? (dark ? "rgba(255,255,255,0.15)" : primaryColor ?? "#111111");
  const btnText = dark ? "#ffffff" : "#ffffff";

  return (
    <nav
      className="relative z-50 flex items-center justify-between px-6 py-4"
      style={{ borderBottom: `1px solid ${borderColor}` }}
    >
      {/* Shop name / logo */}
      <Link
        to={`/${shopSlug}`}
        className="text-sm font-semibold tracking-wide"
        style={{ color: textColor }}
      >
        {shopName}
      </Link>

      {/* Right side: Book + Sign In */}
      <div className="flex items-center gap-3">
        <Link
          to={`/${shopSlug}/book`}
          className="hidden text-sm font-medium sm:block"
          style={{ color: textColor, opacity: 0.75 }}
        >
          Book
        </Link>
        <Link
          to={`/login?redirect=/${shopSlug}`}
          className="rounded-lg px-4 py-1.5 text-sm font-semibold transition hover:opacity-90"
          style={{ backgroundColor: btnBg, color: btnText }}
        >
          Sign In
        </Link>
      </div>
    </nav>
  );
}
