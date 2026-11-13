import { Link } from "@remix-run/react";
import type { SiteTemplateProps } from "./types";
import { TemplateNavbar } from "./TemplateNavbar";

export function ClassicTemplate({ shop, site }: SiteTemplateProps) {
  const fontHeading =
    site.font_heading ? `"${site.font_heading}", serif` : '"Playfair Display", serif';
  const fontBody =
    site.font_body ? `"${site.font_body}", serif` : '"Lora", serif';
  const primary = site.color_primary || "#8B0000";
  const accent = site.color_accent || "#1a1f3a";

  return (
    <main
      className="min-h-screen"
      style={{ backgroundColor: accent, fontFamily: fontBody }}
    >
      <TemplateNavbar
        shopName={shop.name}
        shopSlug={shop.slug}
        primaryColor={primary}
        accentColor={primary}
        dark
      />
      {/* Hero — full-width banner with shop name in large display type */}
      <section
        className="relative flex min-h-[50vh] w-full flex-col items-center justify-center px-6 text-center"
        style={{ backgroundColor: primary }}
      >
        <div
          className="absolute inset-0 opacity-10"
          style={{
            backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' viewBox='0 0 60 60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='none' fill-rule='evenodd'%3E%3Cg fill='%23ffffff' fill-opacity='1'%3E%3Cpath d='M36 34v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zm0-30V0h-2v4h-4v2h4v4h2V6h4V4h-4zM6 34v-4H4v4H0v2h4v4h2v-4h4v-2H6zM6 4V0H4v4H0v2h4v4h2V6h4V4H6z'/%3E%3C/g%3E%3C/g%3E%3C/svg%3E")`,
          }}
        />
        <div className="relative">
          <h1
            className="text-5xl font-bold tracking-wide text-white sm:text-7xl md:text-8xl"
            style={{ fontFamily: fontHeading }}
          >
            {shop.name}
          </h1>
          <p className="mt-4 text-lg text-white/90">{site.tagline}</p>
          <Link
            to={`/${shop.slug}/book`}
            className="mt-8 inline-block border-2 border-white px-8 py-3 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
          >
            Book Your Appointment
          </Link>
        </div>
      </section>

      {/* Ornamental horizontal divider */}
      <div className="flex justify-center py-6">
        <span className="text-2xl text-white/60">✦ · ✦ · ✦</span>
      </div>

      {/* Services — classic menu/price list with ruled lines */}
      <section className="px-6 py-16">
        <h2
          className="mb-10 text-center text-2xl font-semibold text-white"
          style={{ fontFamily: fontHeading }}
        >
          Services
        </h2>
        <div className="mx-auto max-w-2xl">
          {site.services.map((s) => (
            <div
              key={s.name}
              className="flex items-start justify-between border-b border-white/30 py-4"
            >
              <div>
                <h3 className="font-medium text-white">{s.name}</h3>
                <p className="mt-0.5 text-sm text-white/70">{s.description}</p>
              </div>
              <div className="text-right">
                <span className="font-semibold text-white">£{s.price_gbp}</span>
                <span className="ml-2 text-sm text-white/60">
                  {s.duration_minutes} min
                </span>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Ornamental horizontal divider */}
      <div className="flex justify-center py-6">
        <span className="text-2xl text-white/60">✦ · ✦ · ✦</span>
      </div>

      {/* About — left-aligned with decorative divider */}
      <section className="px-6 py-16">
        <div className="mx-auto max-w-2xl">
          <div
            className="mb-6 h-px w-24"
            style={{ backgroundColor: primary }}
          />
          <p className="text-left leading-relaxed text-white/90">{site.about}</p>
        </div>
      </section>

      {/* Ornamental horizontal divider */}
      <div className="flex justify-center py-6">
        <span className="text-2xl text-white/60">✦ · ✦ · ✦</span>
      </div>

      {/* CTA — bordered button */}
      <section className="px-6 py-16 text-center">
        <Link
          to={`/${shop.slug}/book`}
          className="inline-block border-2 border-white px-10 py-4 text-sm font-semibold text-white transition hover:bg-white hover:text-black"
        >
          Book Your Appointment
        </Link>
      </section>
    </main>
  );
}
