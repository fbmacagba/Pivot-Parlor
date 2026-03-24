import { Link } from "@remix-run/react";
import type { SiteTemplateProps } from "./types";
import { TemplateNavbar } from "./TemplateNavbar";

export function MinimalTemplate({ shop, site }: SiteTemplateProps) {
  const fontHeading = site.font_heading ? `"${site.font_heading}", serif` : "serif";
  const fontBody = site.font_body ? `"${site.font_body}", sans-serif` : "sans-serif";

  return (
    <main
      className="min-h-screen bg-white"
      style={{ fontFamily: fontBody }}
    >
      <TemplateNavbar
        shopName={shop.name}
        shopSlug={shop.slug}
        primaryColor="#111111"
        accentColor={site.color_accent}
      />
      {/* Hero — text only */}
      <section className="px-6 py-24 text-center">
        <h1
          className="text-4xl font-bold tracking-tight text-neutral-900 sm:text-5xl"
          style={{ fontFamily: fontHeading }}
        >
          {site.headline}
        </h1>
        <p className="mx-auto mt-4 max-w-xl text-lg text-neutral-600">
          {site.tagline}
        </p>
        <Link
          to={`/${shop.slug}/book`}
          className="mt-8 inline-block rounded border-2 border-neutral-800 px-8 py-3 text-sm font-medium text-neutral-800 transition hover:bg-neutral-800 hover:text-white"
        >
          Book Now
        </Link>
      </section>

      {/* Services grid */}
      <section className="border-t border-neutral-200 px-6 py-16">
        <h2
          className="mb-10 text-center text-2xl font-semibold text-neutral-900"
          style={{ fontFamily: fontHeading }}
        >
          Services
        </h2>
        <div className="mx-auto grid max-w-4xl gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {site.services.map((s) => (
            <div
              key={s.name}
              className="rounded-lg border border-neutral-200 p-6 text-center"
            >
              <h3 className="font-medium text-neutral-900">{s.name}</h3>
              <p className="mt-1 text-sm text-neutral-600">{s.description}</p>
              <p className="mt-2 text-sm text-neutral-500">
                {s.duration_minutes} min · £{s.price_gbp}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* About */}
      <section className="border-t border-neutral-200 px-6 py-16">
        <p className="mx-auto max-w-2xl text-center text-neutral-600 leading-relaxed">
          {site.about}
        </p>
      </section>

      {/* CTA */}
      <section className="border-t border-neutral-200 px-6 py-12 text-center">
        <Link
          to={`/${shop.slug}/book`}
          className="inline-block rounded border-2 px-8 py-3 text-sm font-medium transition"
          style={{
            borderColor: site.color_accent,
            color: site.color_accent,
          }}
        >
          Book Now
        </Link>
      </section>
    </main>
  );
}
