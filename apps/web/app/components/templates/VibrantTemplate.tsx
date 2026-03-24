import { Link } from "@remix-run/react";
import type { SiteTemplateProps } from "./types";
import { TemplateNavbar } from "./TemplateNavbar";

export function VibrantTemplate({ shop, site }: SiteTemplateProps) {
  const fontHeading = site.font_heading ? `"${site.font_heading}", sans-serif` : "sans-serif";
  const fontBody = site.font_body ? `"${site.font_body}", sans-serif` : "sans-serif";
  const primary = site.color_primary || "#1a1a2e";
  const accent = site.color_accent || "#E07C5C";

  return (
    <main
      className="min-h-screen overflow-hidden"
      style={{ fontFamily: fontBody }}
    >
      <TemplateNavbar
        shopName={shop.name}
        shopSlug={shop.slug}
        primaryColor={primary}
        accentColor={accent}
        dark
      />
      {/* Hero — color_primary background, high contrast */}
      <section
        className="relative px-6 py-24 text-center text-white"
        style={{ backgroundColor: primary }}
      >
        <div
          className="absolute bottom-0 left-0 right-0 h-16 -skew-y-2"
          style={{ backgroundColor: "white" }}
        />
        <h1
          className="text-4xl font-bold sm:text-6xl"
          style={{ fontFamily: fontHeading }}
        >
          {site.headline}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg opacity-90">{site.tagline}</p>
        <Link
          to={`/${shop.slug}/book`}
          className="mt-8 inline-block rounded-lg px-10 py-4 text-sm font-bold text-white transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Book Now
        </Link>
      </section>

      {/* Services — colourful icon cards */}
      <section className="bg-white px-6 py-20">
        <h2
          className="mb-12 text-center text-2xl font-bold text-neutral-900"
          style={{ fontFamily: fontHeading }}
        >
          Services
        </h2>
        <div className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {site.services.map((s, i) => (
            <div
              key={s.name}
              className="rounded-xl border-2 p-6 transition hover:shadow-lg"
              style={{
                borderColor: site.catalog_images[i] ? accent : "#e5e7eb",
              }}
            >
              {site.catalog_images[i] && (
                <img
                  src={site.catalog_images[i]}
                  alt=""
                  className="mb-4 h-24 w-24 rounded-lg object-cover"
                />
              )}
              <h3 className="font-bold text-neutral-900">{s.name}</h3>
              <p className="mt-1 text-sm text-neutral-600">{s.description}</p>
              <p className="mt-2 text-sm font-medium" style={{ color: accent }}>
                {s.duration_minutes} min · £{s.price_gbp}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* About — diagonal section */}
      <section
        className="px-6 py-20 text-white"
        style={{ backgroundColor: primary }}
      >
        <p className="mx-auto max-w-2xl text-center leading-relaxed opacity-90">
          {site.about}
        </p>
      </section>

      {/* CTA — loud button */}
      <section className="bg-white px-6 py-16 text-center">
        <Link
          to={`/${shop.slug}/book`}
          className="inline-block rounded-lg px-12 py-4 text-lg font-bold text-white transition hover:opacity-90"
          style={{ backgroundColor: accent }}
        >
          Book Now
        </Link>
      </section>
    </main>
  );
}
