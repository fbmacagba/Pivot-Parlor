import { Link } from "@remix-run/react";
import type { SiteTemplateProps } from "./types";

export function EditorialTemplate({ shop, site }: SiteTemplateProps) {
  const fontHeading = site.font_heading ? `"${site.font_heading}", serif` : "serif";
  const fontBody = site.font_body ? `"${site.font_body}", sans-serif` : "sans-serif";
  const bg = "#faf8f5";

  return (
    <main
      className="min-h-screen"
      style={{ backgroundColor: bg, fontFamily: fontBody }}
    >
      {/* Hero — lifestyle feel, subtle image */}
      <section className="px-6 py-20">
        <div className="mx-auto max-w-4xl">
          {site.hero_image_url && (
            <img
              src={site.hero_image_url}
              alt=""
              className="mb-12 w-full rounded-lg object-cover opacity-90"
              style={{ maxHeight: 320 }}
            />
          )}
          <h1
            className="text-4xl font-medium text-neutral-800 sm:text-5xl"
            style={{ fontFamily: fontHeading }}
          >
            {site.headline}
          </h1>
          <p className="mt-4 text-lg text-neutral-600">{site.tagline}</p>
          <Link
            to={`/${shop.slug}/book`}
            className="mt-8 inline-block border-b-2 border-neutral-800 pb-1 text-sm font-medium text-neutral-800 transition hover:border-neutral-600"
          >
            Book Now →
          </Link>
        </div>
      </section>

      {/* Services — editorial magazine style with index numbers */}
      <section className="border-t border-neutral-200 px-6 py-20">
        <div className="mx-auto max-w-3xl">
          <h2
            className="mb-12 text-2xl font-medium text-neutral-800"
            style={{ fontFamily: fontHeading }}
          >
            Services
          </h2>
          <div className="space-y-12">
            {site.services.map((s, i) => (
              <div key={s.name} className="flex gap-8">
                <span
                  className="text-4xl font-light text-neutral-300"
                  style={{ fontFamily: fontHeading }}
                >
                  {String(i + 1).padStart(2, "0")}
                </span>
                <div className="flex-1">
                  <h3 className="text-lg font-medium text-neutral-800">{s.name}</h3>
                  <p className="mt-1 text-neutral-600">{s.description}</p>
                  <p className="mt-2 text-sm text-neutral-500">
                    {s.duration_minutes} min · £{s.price_gbp}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* About — pull quote styling */}
      <section className="border-t border-neutral-200 px-6 py-20">
        <div className="mx-auto max-w-2xl">
          <blockquote className="border-l-4 border-neutral-300 pl-6 text-lg italic text-neutral-700">
            {site.about}
          </blockquote>
        </div>
      </section>

      {/* CTA — understated */}
      <section className="border-t border-neutral-200 px-6 py-16 text-center">
        <Link
          to={`/${shop.slug}/book`}
          className="inline-block border-b border-neutral-600 pb-1 text-sm font-medium text-neutral-700 transition hover:text-neutral-900"
        >
          Book Now
        </Link>
      </section>
    </main>
  );
}
