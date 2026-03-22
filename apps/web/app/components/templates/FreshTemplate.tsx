import { Link } from "@remix-run/react";
import type { SiteTemplateProps } from "./types";

export function FreshTemplate({ shop, site }: SiteTemplateProps) {
  const fontHeading =
    site.font_heading ? `"${site.font_heading}", sans-serif` : '"DM Sans", sans-serif';
  const fontBody =
    site.font_body ? `"${site.font_body}", sans-serif` : '"Nunito", sans-serif';
  const primary = site.color_primary || "#e8f5e9";
  const accent = site.color_accent || "#fce4ec";

  return (
    <main
      className="min-h-screen"
      style={{ backgroundColor: "#e8f5e9", fontFamily: fontBody }}
    >
      {/* Hero — light section with large friendly headline and soft hero image */}
      <section className="relative overflow-hidden px-6 py-24">
        <div className="relative mx-auto max-w-4xl">
          {site.hero_image_url && (
            <img
              src={site.hero_image_url}
              alt=""
              className="mb-8 w-full rounded-[16px] object-cover opacity-90"
              style={{ maxHeight: 320 }}
            />
          )}
          <h1
            className="text-4xl font-bold text-neutral-800 sm:text-5xl md:text-6xl"
            style={{ fontFamily: fontHeading }}
          >
            {site.headline}
          </h1>
          <p className="mt-4 text-lg text-neutral-600">{site.tagline}</p>
        </div>
      </section>

      {/* Services — pastel-coloured pill cards in responsive 3-column grid */}
      <section className="px-6 py-16">
        <h2
          className="mb-10 text-center text-2xl font-bold text-neutral-800"
          style={{ fontFamily: fontHeading }}
        >
          Services
        </h2>
        <div className="mx-auto grid max-w-4xl gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {site.services.map((s) => (
            <div
              key={s.name}
              className="rounded-[16px] p-6"
              style={{ backgroundColor: "rgba(252, 228, 236, 0.6)" }}
            >
              <h3 className="font-semibold text-neutral-800">{s.name}</h3>
              <p className="mt-1 text-sm text-neutral-600">{s.description}</p>
              <p className="mt-2 text-sm font-medium text-neutral-700">
                {s.duration_minutes} min · £{s.price_gbp}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* About — centred with soft pastel background shape */}
      <section className="relative px-6 py-20">
        <div
          className="absolute left-1/2 top-1/2 h-80 w-80 -translate-x-1/2 -translate-y-1/2 rounded-[16px] opacity-30 blur-3xl"
          style={{ backgroundColor: "#fce4ec" }}
        />
        <div className="relative mx-auto max-w-2xl rounded-[16px] px-8 py-10 text-center">
          <p className="leading-relaxed text-neutral-700">{site.about}</p>
        </div>
      </section>

      {/* CTA — full-width rounded button in accent colour */}
      <section className="px-6 py-16">
        <Link
          to={`/${shop.slug}/book`}
          className="block w-full rounded-[16px] px-10 py-4 text-center text-sm font-semibold transition hover:opacity-90"
          style={{ backgroundColor: "#fce4ec", color: "#880e4f" }}
        >
          Book Your Appointment
        </Link>
      </section>
    </main>
  );
}
