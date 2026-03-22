import { Link } from "@remix-run/react";
import type { SiteTemplateProps } from "./types";

export function LuxuryTemplate({ shop, site }: SiteTemplateProps) {
  const fontHeading = site.font_heading ? `"${site.font_heading}", serif` : "serif";
  const fontBody = site.font_body ? `"${site.font_body}", sans-serif` : "sans-serif";
  const bg = site.color_primary || "#0a0a0a";
  const accent = site.color_accent || "#C9A84C";

  return (
    <main
      className="min-h-screen"
      style={{ backgroundColor: bg, fontFamily: fontBody }}
    >
      {/* Hero — full-bleed image with overlay */}
      <section className="relative min-h-[70vh]">
        {site.hero_image_url && (
          <div className="absolute inset-0">
            <img
              src={site.hero_image_url}
              alt=""
              className="h-full w-full object-cover"
            />
            <div
              className="absolute inset-0"
              style={{ backgroundColor: "rgba(0,0,0,0.5)" }}
            />
          </div>
        )}
        <div className="relative flex min-h-[70vh] flex-col items-center justify-center px-6 text-center text-white">
          <h1
            className="text-4xl font-bold sm:text-6xl"
            style={{ fontFamily: fontHeading }}
          >
            {site.headline}
          </h1>
          <p className="mt-4 text-lg opacity-90">{site.tagline}</p>
          <Link
            to={`/${shop.slug}/book`}
            className="mt-8 inline-block rounded px-8 py-4 text-sm font-semibold text-black transition hover:opacity-90"
            style={{ backgroundColor: accent }}
          >
            Book Now
          </Link>
        </div>
      </section>

      {/* Services — elegant cards with gold borders */}
      <section className="px-6 py-20">
        <h2
          className="mb-12 text-center text-2xl font-semibold text-white"
          style={{ fontFamily: fontHeading }}
        >
          Services
        </h2>
        <div className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {site.services.map((s) => (
            <div
              key={s.name}
              className="rounded-lg border p-6"
              style={{ borderColor: `${accent}40` }}
            >
              <h3 className="font-medium text-white">{s.name}</h3>
              <p className="mt-1 text-sm text-white/70">{s.description}</p>
              <p className="mt-2 text-sm" style={{ color: accent }}>
                {s.duration_minutes} min · £{s.price_gbp}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* About — decorative divider */}
      <section className="px-6 py-16">
        <div
          className="mx-auto mb-8 h-px w-24"
          style={{ backgroundColor: accent }}
        />
        <p className="mx-auto max-w-2xl text-center text-white/80 leading-relaxed">
          {site.about}
        </p>
      </section>

      {/* CTA */}
      <section className="px-6 py-16 text-center">
        <Link
          to={`/${shop.slug}/book`}
          className="inline-block rounded px-10 py-4 text-sm font-semibold text-black transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Book Now
        </Link>
      </section>
    </main>
  );
}
