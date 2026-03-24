import { Link } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { Button } from "~/components/ui/Button";
import { Calendar, Clock, Star, Users, Zap } from "lucide-react";

export const meta: MetaFunction = () => [
  { title: "Pivot Parlor — Smart Booking for Beauty & Barber Shops" },
  {
    name: "description",
    content:
      "AI-branded booking pages, staff scheduling, and automated reminders for beauty parlours and barber shops. £100 setup fee, then 10% commission only.",
  },
];

export default function Homepage() {
  return (
    <main>
      {/* ── HERO ──────────────────────────────────────────────────────── */}
      <section className="relative overflow-hidden px-4 pb-24 pt-20 sm:px-6 lg:px-8">
        <div
          className="pointer-events-none absolute inset-0 -z-10"
          aria-hidden
        >
          <div className="absolute left-1/4 top-0 h-[600px] w-[600px] -translate-x-1/2 rounded-full bg-gold/5 blur-3xl" />
        </div>

        <div className="mx-auto grid max-w-7xl items-center gap-16 lg:grid-cols-2">
          {/* Copy */}
          <div>
            {/* Social proof */}
            <div className="mb-6 flex items-center gap-2">
              <div className="flex text-gold">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} className="h-4 w-4 fill-current" />
                ))}
              </div>
              <span className="text-sm text-white/60">
                Trusted by shops across London
              </span>
            </div>

            <h1 className="font-heading text-5xl font-bold leading-tight text-white sm:text-6xl lg:text-7xl">
              One platform.{" "}
              <span className="gradient-text">Every chair.</span> Every
              booking.
            </h1>

            <p className="mt-6 text-lg text-white/70 leading-relaxed">
              Pivot Parlor powers beauty parlours and barber shops with
              AI‑branded booking pages, smart scheduling, and no monthly fees.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Button asChild size="xl">
                <Link to="/contact">Get your shop live →</Link>
              </Button>
              <Button asChild variant="ghost" size="xl" className="text-white/80">
                <a href="#how-it-works">See how it works</a>
              </Button>
            </div>
            <p className="mt-3 text-xs text-white/40">
              £100 one-time setup · No monthly fees · Live in 24 hours
            </p>
          </div>

          {/* Booking UI mockup */}
          <div className="glass rounded-2xl p-6 shadow-2xl shadow-gold/5">
            <p className="mb-4 text-xs font-semibold uppercase tracking-wider text-white/40">
              Sample booking page
            </p>
            <div className="mb-3 h-8 w-32 rounded-md bg-gold/20" />
            <div className="mb-6 space-y-2">
              <div className="h-4 w-full rounded bg-white/10" />
              <div className="h-4 w-3/4 rounded bg-white/10" />
            </div>
            <div className="grid grid-cols-3 gap-2 mb-4">
              {["09:00", "09:30", "10:00", "10:30", "11:00", "11:30"].map(
                (t) => (
                  <div
                    key={t}
                    className="rounded-lg border border-gold/20 bg-gold/5 py-2 text-center text-xs text-gold"
                  >
                    {t}
                  </div>
                )
              )}
            </div>
            <div className="rounded-xl bg-gold/20 py-3 text-center text-sm font-semibold text-gold">
              Confirm Booking →
            </div>
          </div>
        </div>
      </section>

      {/* ── STATS ─────────────────────────────────────────────────────── */}
      <section className="border-y border-white/10 bg-dark-100">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-12 gap-y-4 px-4 py-8 text-center sm:px-6">
          {[
            ["24", "Shops live"],
            ["3,200+", "Bookings processed"],
            ["10%", "Commission only — no hidden fees"],
          ].map(([val, label]) => (
            <div key={label}>
              <span className="font-heading text-3xl font-bold text-gold">
                {val}
              </span>
              <span className="ml-2 text-sm text-white/60">{label}</span>
            </div>
          ))}
        </div>
      </section>

      {/* ── FEATURES ──────────────────────────────────────────────────── */}
      <section id="features" className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl">
          <h2 className="text-center font-heading text-4xl font-bold text-white">
            Everything your shop needs
          </h2>
          <p className="mx-auto mt-4 max-w-xl text-center text-white/60">
            One platform built for independent shops that want to compete
            online without the tech headache.
          </p>
          <div className="mt-16 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {[
              {
                icon: Calendar,
                title: "Online booking",
                desc: "Customers book 24/7 from your AI-branded page — no phone calls needed.",
              },
              {
                icon: Users,
                title: "Staff scheduling",
                desc: "Manage shifts, availability, and services across your whole team.",
              },
              {
                icon: Clock,
                title: "Waitlist system",
                desc: "Never lose a customer when slots are full — auto-notifies when space opens.",
              },
              {
                icon: Zap,
                title: "Auto reminders",
                desc: "Email and SMS reminders reduce no-shows and keep your calendar full.",
              },
            ].map(({ icon: Icon, title, desc }) => (
              <div
                key={title}
                className="group rounded-xl border border-white/10 bg-dark-100 p-6 transition-all hover:border-gold/30"
              >
                <div className="mb-4 inline-block rounded-lg bg-gold/10 p-3">
                  <Icon className="h-5 w-5 text-gold" />
                </div>
                <h3 className="font-heading text-lg font-semibold text-white">
                  {title}
                </h3>
                <p className="mt-2 text-sm text-white/60">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        className="bg-dark-100 px-4 py-24 sm:px-6 lg:px-8"
      >
        <div className="mx-auto max-w-7xl">
          <h2 className="text-center font-heading text-4xl font-bold text-white">
            How it works
          </h2>
          <div className="mt-16 grid gap-8 md:grid-cols-3">
            {[
              {
                step: "01",
                title: "Developer onboards your shop",
                desc: "We handle the entire setup — tech, domain, and configuration — so you don't have to.",
              },
              {
                step: "02",
                title: "AI builds your branded page",
                desc: "Our AI generates a unique booking page with your brand colours, fonts, and copy.",
              },
              {
                step: "03",
                title: "Customers find you and book",
                desc: "Your shop goes live. Customers discover, browse services, and book online instantly.",
              },
            ].map(({ step, title, desc }) => (
              <div key={step} className="text-center">
                <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-gold/30 bg-gold/10">
                  <span className="font-heading text-lg font-bold text-gold">
                    {step}
                  </span>
                </div>
                <h3 className="font-heading text-xl font-semibold text-white">
                  {title}
                </h3>
                <p className="mt-2 text-sm text-white/60">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ───────────────────────────────────────────────────── */}
      <section className="px-4 py-24 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-heading text-4xl font-bold text-white">
            We only earn when you earn
          </h2>
          <p className="mt-4 text-white/60">
            One-time £100 setup fee covers everything — onboarding, training,
            and your AI-generated booking site. Then just 10% on completed
            bookings. No monthly fees, ever.
          </p>
          <div className="mt-12 rounded-2xl border border-gold/30 bg-dark-100 p-10">
            <div className="flex flex-wrap items-end justify-center gap-x-8 gap-y-4">
              {[
                ["£100", "one-time setup"],
                ["£0", "/ month"],
                ["10%", "per booking"],
              ].map(([val, unit]) => (
                <div key={unit} className="text-center">
                  <p className="font-heading text-5xl font-bold text-gold">
                    {val}
                  </p>
                  <p className="mt-1 text-sm text-white/50">{unit}</p>
                </div>
              ))}
            </div>
            <div className="mt-8">
              <Button asChild size="lg">
                <Link to="/contact">Get started →</Link>
              </Button>
              <p className="mt-3 text-xs text-white/40">
                £100 setup · No monthly fees · Live in 24 hours
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA BANNER ────────────────────────────────────────────────── */}
      <section className="bg-gold px-4 py-16 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <h2 className="font-heading text-4xl font-bold text-dark">
            Ready to bring your shop online?
          </h2>
          <div className="mt-6">
            <Button asChild variant="secondary" size="lg">
              <Link to="/contact">Get started →</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
