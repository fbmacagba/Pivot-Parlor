import { Link } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { Button } from "~/components/ui/Button";

export const meta: MetaFunction = () => [
  { title: "About Us | Pivot Parlor" },
  { name: "description", content: "Built for the people behind the chair — the story behind Pivot Parlor." },
];

export default function About() {
  return (
    <main>
      {/* Hero */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-4xl text-center">
          <h1 className="font-heading text-5xl font-bold text-white sm:text-6xl">
            Built for the people{" "}
            <span className="text-gold">behind the chair</span>
          </h1>
          <p className="mx-auto mt-6 max-w-2xl text-lg text-white/70">
            Pivot Parlor was born from a simple idea: every barber and beauty
            professional deserves a booking system as sharp as their craft. No
            bloated software. No monthly fees. Just a platform that works as
            hard as you do.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-4">
            <Button asChild size="lg">
              <Link to="/contact">Get your shop on Pivot</Link>
            </Button>
            <a
              href="https://www.linkedin.com/in/fbmacagba"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-full border border-gold px-4 py-2 text-sm text-gold transition-colors hover:bg-gold hover:text-dark"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
              </svg>
              DM us on LinkedIn
            </a>
          </div>
        </div>
      </section>

      {/* Mission */}
      <section className="bg-dark-100 px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-gold">Our mission</p>
          <h2 className="font-heading text-4xl font-bold text-white">
            Removing friction between craftspeople and customers
          </h2>
          <p className="mt-6 text-lg text-white/70 leading-relaxed">
            We exist to remove the friction between great craftspeople and the
            customers who need them. By combining AI-powered branding with smart
            scheduling, we help shops of every size compete online — without the
            tech headache.
          </p>
        </div>
      </section>

      {/* How it works */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center font-heading text-4xl font-bold text-white mb-16">How it works</h2>
          <div className="grid gap-8 md:grid-cols-3">
            {[
              { title: "You focus on your craft", desc: "We handle the tech — setup, maintenance, and updates." },
              { title: "Your shop gets an AI-branded page", desc: "Unique design, copy, and identity generated in minutes." },
              { title: "We only earn when you earn", desc: "£100 one-time setup, then 10% commission on completed bookings only." },
            ].map(({ title, desc }, i) => (
              <div key={title} className="rounded-xl border border-white/10 bg-dark-100 p-6">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-full bg-gold/10 text-gold font-heading font-bold">
                  {String(i + 1).padStart(2, "0")}
                </div>
                <h3 className="font-heading text-lg font-semibold text-white">{title}</h3>
                <p className="mt-2 text-sm text-white/60">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why Pivot Parlor */}
      <section className="bg-dark-100 px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center font-heading text-4xl font-bold text-white mb-16">Why Pivot Parlor</h2>
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { title: "£100 one-time setup", desc: "No monthly fees. Just 10% commission on completed bookings." },
              { title: "AI-branded pages", desc: "Your shop gets a unique identity, not a template." },
              { title: "Built on Cloudflare", desc: "99.99% uptime, global edge network." },
              { title: "GDPR compliant", desc: "Your customer data is isolated and protected." },
            ].map(({ title, desc }) => (
              <div key={title} className="rounded-xl border border-white/10 bg-dark p-5">
                <div className="mb-2 h-1 w-8 rounded bg-gold" />
                <h3 className="font-heading text-base font-semibold text-white">{title}</h3>
                <p className="mt-1.5 text-sm text-white/60">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Team */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-heading text-4xl font-bold text-white mb-12">The team</h2>
          <div className="mx-auto max-w-sm rounded-2xl border border-gold/20 bg-dark-100 p-8">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-gold/20 text-2xl font-heading font-bold text-gold">F</div>
            <p className="font-heading text-xl font-semibold text-white">Ferdinand</p>
            <p className="text-sm text-gold mt-1">Founder & Developer</p>
            <p className="text-xs text-white/50 mt-0.5">London, UK</p>
            <p className="mt-4 text-sm text-white/70">
              Full-stack developer and AI strategist building tools that give independent shops
              the same digital edge as big brands.
            </p>
          </div>
        </div>
      </section>

      {/* Sticky CTA */}
      <section className="bg-gold px-4 py-16 sm:px-6 lg:px-8 text-center">
        <h2 className="font-heading text-4xl font-bold text-dark">Ready to bring your shop online?</h2>
        <div className="mt-6">
          <Button asChild variant="secondary" size="lg">
            <Link to="/contact">Get your shop on Pivot →</Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
