import type { Density, Motif } from "@repo/utils";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { MotifDecor, sectionPadY } from "~/components/site/sections/bits";

/** Signature "gallery": the shop's own imagery as a look-book wall — every
 *  third tile runs tall so the grid reads composed, not templated. Images
 *  are ambiance (decorative): empty alt, lazy. */
export function SignatureGallerySection({
  ctx,
  images,
  density,
  motif,
}: {
  ctx: SiteRenderContext;
  images: string[];
  density: Density;
  motif: Motif;
}) {
  if (images.length < 3) return null;
  const tiles = images.slice(0, 8);
  return (
    <section className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] px-4 md:px-6 ${sectionPadY(density)}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-right-16 top-10" /> : null}
      <div className="relative mx-auto max-w-7xl">
        {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : null}
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-[color:var(--st-accent-text)]">The space</p>
        <h2 className="mt-3 pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">
          Inside {ctx.site.shop_name}
        </h2>
        <ul className="mt-10 grid auto-rows-[9rem] grid-cols-2 gap-3 md:auto-rows-[11rem] md:grid-cols-4 md:gap-4">
          {tiles.map((src, i) => (
            <li key={src} className={`overflow-hidden rounded-[var(--st-r-md)]${i % 3 === 0 ? " row-span-2" : ""}`}>
              <img src={src} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover transition duration-500 hover:scale-105" />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
