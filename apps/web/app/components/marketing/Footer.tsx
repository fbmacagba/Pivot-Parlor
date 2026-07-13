import { Link } from "@remix-run/react";

export function Footer() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-white/10 bg-dark">
      <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 gap-10 md:grid-cols-4">
          {/* Brand */}
          <div className="md:col-span-2">
            <p className="font-heading text-2xl font-bold">
              Pivot <span className="text-gold">Parlor</span>
            </p>
            <p className="mt-3 max-w-sm text-sm text-white/60">
              AI-branded booking pages, staff scheduling, and automated reminders
              for beauty parlours and barber shops. Zero monthly fees, 10%
              commission only.
            </p>
            <div className="mt-5 flex items-center gap-4">
              <a
                href="https://www.linkedin.com/in/fbmacagba"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 rounded-full border border-gold px-4 py-2 text-sm text-gold transition-colors hover:bg-gold hover:text-dark"
              >
                <LinkedInIcon /> DM us on LinkedIn
              </a>
            </div>
            <p className="mt-4 text-xs text-white/60">
              dev@pivotparlor.com · Moselle Avenue, London, UK, N22 6ET
            </p>
          </div>

          {/* Navigation */}
          <div>
            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-white/60">
              Navigation
            </p>
            <ul className="space-y-2.5 text-sm text-white/60">
              {[
                ["/", "Home"],
                ["/about", "About Us"],
                ["/pricing", "Pricing"],
                ["/contact", "Contact"],
              ].map(([href, label]) => (
                <li key={href}>
                  <Link to={href} className="hover:text-gold transition-colors">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Legal */}
          <div>
            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-white/60">
              Legal
            </p>
            <ul className="space-y-2.5 text-sm text-white/60">
              {[
                ["/privacy", "Privacy Policy"],
                ["/terms", "Terms of Service"],
                ["/cookies", "Cookie Policy"],
              ].map(([href, label]) => (
                <li key={href}>
                  <Link to={href} className="hover:text-gold transition-colors">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-12 border-t border-white/10 pt-8 text-center text-xs text-white/50">
          © {year} Pivot Parlor. All rights reserved.
        </div>
      </div>
    </footer>
  );
}

function LinkedInIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/>
    </svg>
  );
}
