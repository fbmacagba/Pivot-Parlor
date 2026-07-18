import { Link } from "@remix-run/react";
import type { MetaFunction } from "@remix-run/cloudflare";
import { Button } from "~/components/ui/Button";
import { Calendar, Clock, Users, Zap } from "lucide-react";

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
      <section className="relative overflow-hidden px-4 pb-[clamp(4.5rem,12vw,7rem)] pt-16 sm:px-6 sm:pt-20 lg:px-8">
        <div className="mx-auto grid max-w-7xl items-start gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,min(28rem,45%))] lg:gap-x-16 lg:gap-y-0">
          {/* Copy */}
          <div className="pt-1">
            <h1 className="font-heading text-5xl font-bold leading-[1.08] text-white sm:text-6xl lg:text-7xl">
              One platform.{" "}
              <span className="text-gold">Every chair.</span> Every booking.
            </h1>

            <p className="mt-7 max-w-[65ch] text-lg leading-relaxed text-white/70 sm:mt-8">
              AI‑branded booking pages and smart scheduling for independent
              salons and barbershops. No monthly fees.
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3 sm:gap-4">
              <Button asChild size="xl">
                <Link to="/contact">Get your shop live →</Link>
              </Button>
              <Button asChild variant="ghost" size="xl" className="text-white/80">
                <a href="#how-it-works">See how it works</a>
              </Button>
            </div>
            <p className="mt-3 text-xs text-white/60">
              £100 one-time setup · No monthly fees · Live in 24 hours
            </p>
          </div>

          {/* Booking UI mockup */}
          <div className="w-full rounded-2xl border border-white/10 bg-dark-100/90 p-6 shadow-xl shadow-black/20 lg:justify-self-end">
            <p className="mb-5 text-xs font-medium text-white/60">Sample booking</p>
            <div className="mb-4 h-8 w-32 rounded-md bg-gold/20" />
            <div className="mb-6 space-y-2.5">
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

      {/* ── FEATURES ──────────────────────────────────────────────────── */}
      <section
        id="features"
        className="border-t border-white/[0.06] px-4 py-[clamp(4.5rem,10vw,7.5rem)] sm:px-6 lg:px-8"
      >
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-12 lg:flex-row lg:items-start lg:justify-between lg:gap-16">
            <header className="max-w-md text-center lg:shrink-0 lg:pt-1 lg:text-left">
              <h2 className="font-heading text-4xl font-bold leading-tight text-white">
                What you get
              </h2>
              <p className="mt-4 text-base leading-relaxed text-white/60">
                Booking, team, and reminders in one place. No extra stack to
                learn.
              </p>
            </header>
            <div className="grid min-w-0 flex-1 grid-cols-1 gap-x-10 gap-y-11 sm:grid-cols-2">
              {[
                {
                  icon: Calendar,
                  title: "Online booking",
                  desc: "Customers book from your page any time without calling.",
                },
                {
                  icon: Users,
                  title: "Staff scheduling",
                  desc: "Availability and services across your team in one view.",
                },
                {
                  icon: Clock,
                  title: "Waitlist",
                  desc: "When you are full, customers get notified when a slot opens.",
                },
                {
                  icon: Zap,
                  title: "Reminders",
                  desc: "Automatic email reminders to cut no-shows.",
                },
              ].map(({ icon: Icon, title, desc }) => (
                <div key={title} className="flex gap-4">
                  <div className="mt-0.5 shrink-0 rounded-lg bg-gold/10 p-2.5">
                    <Icon className="h-5 w-5 text-gold" />
                  </div>
                  <div>
                    <h3 className="font-heading text-lg font-semibold leading-snug text-white">
                      {title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-white/60">
                      {desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ──────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        className="bg-dark-100 px-4 py-[clamp(5rem,11vw,8rem)] sm:px-6 lg:px-8"
      >
        <div className="mx-auto max-w-6xl">
          <h2 className="text-center font-heading text-[clamp(1.75rem,4vw,2.25rem)] font-bold text-white">
            How it works
          </h2>
          <div className="mt-14 grid gap-12 md:grid-cols-3 md:gap-10 lg:mt-16 lg:gap-14">
            {[
              {
                step: "01",
                title: "Developer onboards your shop",
                desc: "We handle the technical setup: your site and booking system, so you do not have to.",
              },
              {
                step: "02",
                title: "AI builds your branded page",
                desc: "Our AI generates a unique booking page with your brand colours, fonts, and copy.",
              },
              {
                step: "03",
                title: "Customers find you and book",
                desc: "Your shop goes live. Customers discover, browse services, and book online.",
              },
            ].map(({ step, title, desc }) => (
              <div key={step} className="text-center md:text-left">
                <div className="mx-auto mb-5 flex h-11 w-11 items-center justify-center rounded-full border border-gold/30 bg-gold/10 md:mx-0">
                  <span className="font-heading text-base font-bold text-gold">
                    {step}
                  </span>
                </div>
                <h3 className="font-heading text-lg font-semibold leading-snug text-white sm:text-xl">
                  {title}
                </h3>
                <p className="mx-auto mt-3 max-w-[52ch] text-sm leading-relaxed text-white/60 md:mx-0">
                  {desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── PRICING ───────────────────────────────────────────────────── */}
      <section className="px-4 py-[clamp(4rem,10vw,6.5rem)] sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-[clamp(1.75rem,4vw,2.25rem)] font-bold text-white">
            We only earn when you earn
          </h2>
          <p className="mt-5 max-w-prose mx-auto text-base leading-relaxed text-white/60">
            One-time £100 setup covers onboarding, training, and your AI booking
            site. Then 10% on completed bookings. No monthly fees.
          </p>
          <div className="mt-10 rounded-2xl border border-gold/30 bg-dark-100 px-6 py-9 sm:p-10">
            <div className="flex flex-wrap items-end justify-center gap-x-12 gap-y-8 sm:gap-x-16">
              {[
                ["£100", "one-time setup"],
                ["£0", "/ month"],
                ["10%", "per booking"],
              ].map(([val, unit]) => (
                <div key={unit} className="min-w-[5.5rem] text-center">
                  <p className="font-heading text-[clamp(2.75rem,7vw,3.25rem)] font-bold tabular-nums text-gold">
                    {val}
                  </p>
                  <p className="mt-2 text-sm text-white/50">{unit}</p>
                </div>
              ))}
            </div>
            <div className="mt-10 border-t border-white/10 pt-8">
              <Button asChild size="lg">
                <Link to="/contact">Get started →</Link>
              </Button>
              <p className="mt-4 text-xs text-white/60">
                £100 setup · No monthly fees · Live in 24 hours
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA BANNER ────────────────────────────────────────────────── */}
      <section className="bg-gold px-4 py-[clamp(3.25rem,6vw,4.75rem)] sm:px-6 lg:px-8">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="font-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold leading-tight text-dark">
            Ready to bring your shop online?
          </h2>
          <div className="mt-8">
            <Button asChild variant="secondary" size="lg">
              <Link to="/contact">Get started →</Link>
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}
