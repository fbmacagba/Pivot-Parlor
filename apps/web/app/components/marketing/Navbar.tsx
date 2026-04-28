import { Link, useLocation } from "@remix-run/react";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { Button } from "~/components/ui/Button";

const NAV_LINKS = [
  { href: "/", label: "Home" },
  { href: "/about", label: "About" },
  { href: "/#features", label: "Features" },
  { href: "/pricing", label: "Pricing" },
  { href: "/contact", label: "Contact" },
];

export function Navbar() {
  const [open, setOpen] = useState(false);
  const { pathname } = useLocation();

  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-dark/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2">
          <span className="font-heading text-xl font-bold text-white">
            Pivot <span className="text-gold">Parlor</span>
          </span>
          <span className="h-1.5 w-1.5 rounded-full bg-gold" aria-hidden />
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <Link
              key={href}
              to={href}
              className={`text-sm transition-colors hover:text-gold ${
                pathname === href ? "text-gold" : "text-white/70"
              }`}
            >
              {label}
            </Link>
          ))}
        </nav>

        {/* Desktop CTAs */}
        <div className="hidden items-center gap-3 md:flex">
          <a
            href="https://www.linkedin.com/in/fbmacagba"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 rounded-full border border-gold px-4 py-2 text-sm text-gold transition-colors hover:bg-gold hover:text-black"
          >
            <LinkedInIcon />
            DM us on LinkedIn
          </a>
          <Button asChild size="sm">
            <Link to="/contact">Get your shop on Pivot →</Link>
          </Button>
        </div>

        {/* Mobile menu toggle */}
        <button
          className="flex items-center rounded-md p-2 text-white/70 hover:text-white md:hidden"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="border-t border-white/10 bg-dark px-4 pb-6 pt-4 md:hidden">
          <nav className="flex flex-col gap-4">
            {NAV_LINKS.map(({ href, label }) => (
              <Link
                key={href}
                to={href}
                onClick={() => setOpen(false)}
                className="text-sm text-white/70 hover:text-gold"
              >
                {label}
              </Link>
            ))}
            <hr className="border-white/10" />
            <a
              href="https://www.linkedin.com/in/fbmacagba"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-full border border-gold px-4 py-2 text-sm text-gold transition-colors hover:bg-gold hover:text-black"
            >
              <LinkedInIcon /> DM us on LinkedIn
            </a>
            <Button asChild size="sm" className="w-full">
              <Link to="/contact" onClick={() => setOpen(false)}>
                Get your shop on Pivot →
              </Link>
            </Button>
          </nav>
        </div>
      )}
    </header>
  );
}

function LinkedInIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
    </svg>
  );
}
