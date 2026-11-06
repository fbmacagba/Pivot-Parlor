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
  // Only counts that fill the grid: 3 composes as one tall frame beside two;
  // 6 fills the wall exactly (every third tile spans two rows, so 6 tiles take
  // 8 cells: two full rows of 4 on desktop, four of 2 on phones). Any other
  // count left ragged holes at the end of the wall.
  const tiles = images.slice(0, images.length >= 6 ? 6 : 3);
  return (
    <section className={`relative overflow-hidden border-t border-[color:var(--st-line-10)] px-4 md:px-6 ${sectionPadY(density)}`}>
      {motif !== "line" ? <MotifDecor motif={motif} className="-right-16 top-10" /> : null}
      <div className="relative mx-auto max-w-7xl">
        {motif === "line" ? <MotifDecor motif="line" className="mb-6 w-fit" /> : null}
        <h2 className="pp-heading text-[clamp(1.75rem,4vw,2.5rem)] font-bold text-[color:var(--st-ink)]">
          Inside {ctx.site.shop_name}
        </h2>
        {/* Three photos (a generated "space" set) compose as one tall frame
            beside two stacked ones; a larger pool keeps the look-book wall. */}
        <ul
          className={`mt-10 grid gap-3 md:gap-4 ${
            tiles.length === 3
              ? "auto-rows-[10rem] grid-cols-[1.35fr_1fr] md:auto-rows-[15rem]"
              : "auto-rows-[9rem] grid-flow-dense grid-cols-2 md:auto-rows-[11rem] md:grid-cols-4"
          }`}
        >
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
