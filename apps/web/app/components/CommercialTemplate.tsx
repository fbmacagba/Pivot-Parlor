import { useParams } from "@remix-run/react";
import { Fragment, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { CommercialShopChrome } from "~/components/CommercialShopChrome";
import type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";
import { archetypeFor } from "~/components/siteArchetype";
import { bookingLabel } from "~/lib/shopLabels";
import type { Archetype, SectionKey } from "~/components/siteArchetype";
import { normalizeDesignSpec, seedComposeDesignSpec, isPortfolioDemoShop } from "@repo/utils";
import { composeRenderPlan, downgradeForImages } from "~/components/site/composePlan";
import type { RenderPlan } from "~/components/site/composePlan";
import { HeroSection } from "~/components/site/sections/HeroSection";
import { HeroSplitSection } from "~/components/site/sections/HeroSplitSection";
import { HeroEditorialSection } from "~/components/site/sections/HeroEditorialSection";
import { HeroMinimalSection } from "~/components/site/sections/HeroMinimalSection";
import { FinalCtaSection } from "~/components/site/sections/FinalCtaSection";
import { TrustSection } from "~/components/site/sections/TrustSection";
import { TrustChipsSection } from "~/components/site/sections/TrustChipsSection";
import { ServicesSection } from "~/components/site/sections/ServicesSection";
import { ServicesRowsSection } from "~/components/site/sections/ServicesRowsSection";
import { ServicesShowcaseSection } from "~/components/site/sections/ServicesShowcaseSection";
import { AboutSection } from "~/components/site/sections/AboutSection";
import { AboutSplitImageSection } from "~/components/site/sections/AboutSplitImageSection";
import { AboutStorySection } from "~/components/site/sections/AboutStorySection";
import { TeamSection } from "~/components/site/sections/TeamSection";
import { TeamStripSection } from "~/components/site/sections/TeamStripSection";
import { HowSection } from "~/components/site/sections/HowSection";
import { ReviewsSection } from "~/components/site/sections/ReviewsSection";
import { ReviewsMarqueeSection } from "~/components/site/sections/ReviewsMarqueeSection";
import { ReviewsSpotlightSection } from "~/components/site/sections/ReviewsSpotlightSection";
import { LocationSection } from "~/components/site/sections/LocationSection";
import { LocationMapFirstSection } from "~/components/site/sections/LocationMapFirstSection";
import { SignatureGallerySection } from "~/components/site/sections/SignatureGallerySection";
import { SignatureSpotlightSection } from "~/components/site/sections/SignatureSpotlightSection";
import { hasOpenDay, isGenericCategory } from "~/components/site/sections/bits";
import type { SiteRenderContext } from "~/components/site/sectionContext";
import { Reveal } from "~/components/site/motion/Reveal";
import "~/components/site/motion/motion.css";

export type { SiteData, ShopSettings } from "~/components/commercialSiteTypes";

export type StaffMember = {
  id: string;
  display_name: string;
  bio?: string;
  avatar_url?: string;
  speciality?: string;
};

export type Service = {
  id: string;
  name: string;
  description?: string;
  price_gbp: number;
  duration_minutes: number;
  category?: string;
  image_url?: string;
};

export type Review = {
  id: string;
  customer_name: string;
  rating: number;
  body: string;
  created_at: string;
};

export type CommercialTemplateProps = {
  site: SiteData;
  staff?: StaffMember[];
  services?: Service[];
  reviews?: Review[];
  settings?: ShopSettings;
};

function trimMediaUrl(url: string | undefined | null): string {
  if (typeof url !== "string") return "";
  return url.trim();
}

type Pillar = { title: string; body?: string; icon: ReactNode };

export default function CommercialTemplate({
  site,
  staff = [],
  services = [],
  reviews = [],
  settings = {},
}: CommercialTemplateProps) {
  const params = useParams();
  const shopSlug = params.shopSlug ?? "";
  const demo = isPortfolioDemoShop(shopSlug);

  const [category, setCategory] = useState<string>("All");
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const svc of services) {
      // Keep real categories only; the generic "Service" is hidden on cards too.
      if (!isGenericCategory(svc.category)) s.add(svc.category!.trim());
    }
    return ["All", ...Array.from(s).sort()];
  }, [services]);

  const filteredServices =
    category === "All" ? services : services.filter((s) => (s.category ?? "").trim() === category);

  const sortedReviews = useMemo(
    () =>
      [...reviews]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 6),
    [reviews]
  );

  const reviewCount = site.review_count ?? reviews.length;
  const hasAddress = Boolean(settings.address?.trim());
  // Hours or a phone number are worth a "visit us" section on their own; this
  // used to require an address, so a shop with hours but no address hid them.
  const hasHours = hasOpenDay(settings.hours_json);
  const hasVisitInfo = hasAddress || hasHours || Boolean(settings.phone?.trim());
  const galleryImages = (site.gallery_images ?? []).map((u) => u.trim()).filter(Boolean);

  const scrollToId = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const heroSrc = trimMediaUrl(site.hero_image_url);
  const heroHeadline =
    typeof site.headline === "string" && site.headline.trim() ? site.headline.trim() : site.shop_name;
  const heroTagline = typeof site.tagline === "string" ? site.tagline.trim() : "";
  const aboutText = typeof site.about === "string" ? site.about.trim() : "";

  // Only ever show real review data: never invented ratings or counts (trust +
  // ASA/CAP). The rating is the average of the shop's own published reviews;
  // with no rating there is no social-proof line at all (this used to default
  // to "5.0" and to a "10+ happy clients" floor).
  const realRating =
    typeof site.rating === "number" && Number.isFinite(site.rating)
      ? site.rating
      : reviews.length > 0
        ? reviews.reduce((acc, r) => acc + r.rating, 0) / reviews.length
        : null;
  const hasSocialProof = reviewCount > 0 && realRating !== null;
  const statsRating = realRating !== null ? realRating.toFixed(1) : "";

  // Per-shop design intent (WS-6). Every field is optional; when absent we fall
  // back to the template's original literals so pre-WS-6 sites render unchanged.
  // A demo renders its generated copy like any shop; its one consolidated
  // disclosure lives in the chrome, the booking flow and the assistant.
  const archetype: Archetype = archetypeFor(site.layout_mood);
  const heroCentered = archetype.heroAlign === "center";

  const trustSignals = (site.trust_signals ?? []).map((s) => s.trim()).filter(Boolean);
  // The trust strip sits directly under the hero and already lists the
  // signals, so the hero's small print carries a plain booking line instead
  // of repeating them. (The old fallback promised "No card required ·
  // Cancel anytime", which is false for deposit-taking shops.)
  const heroSubline = "Book online, any time. No account needed.";
  // One booking verb and one case across the shop's buttons (header, hero,
  // final call to action, phone menu and bar); names keep their capitals.
  const bookLabel = bookingLabel(site.hero_cta, [site.shop_name, ...staff.map((m) => m.display_name)]);
  const aboutHeading =
    typeof site.about_title === "string" && site.about_title.trim()
      ? site.about_title.trim()
      : "Why book with us";

  const defaultPillars: Pillar[] = [
    { title: "Choose who you see", body: "Pick a team member, or take the first free time.", icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 18.75l-.813-2.846a4.5 4.5 0 0 0-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 0 0 3.09-3.09L9 5.25l.813 2.847a4.5 4.5 0 0 0 3.09 3.09L15.75 12l-2.847.813a4.5 4.5 0 0 0-3.09 3.09ZM18.259 8.715 18 9.75l-.259-1.035a3.375 3.375 0 0 0-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 0 0 2.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 0 0 2.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 0 0-2.456 2.456Z" /> },
    { title: "Easy Booking", body: "Pick a service and time in seconds. No phone tag.", icon: <path strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5a2.25 2.25 0 0 0 2.25-2.25m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5a2.25 2.25 0 0 1 2.25 2.25v7.5" /> },
    { title: "Prices up front", body: "Every service shows its price and time before you book.", icon: <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" /> },
  ];
  // USP titles come straight from the shop's generated spec — never invent a
  // supporting line, so the body is simply omitted; icons cycle from the stock set.
  const usps = (site.usps ?? []).map((s) => s.trim()).filter(Boolean);
  const pillars: Pillar[] =
    usps.length >= 3
      ? usps.slice(0, 3).map((title, i) => ({ title, icon: defaultPillars[i % 3].icon }))
      : defaultPillars;

  const stepIcons = [
    <path key="browse" strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />,
    <path key="diary" strokeLinecap="round" strokeLinejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5a2.25 2.25 0 0 0 2.25-2.25m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5a2.25 2.25 0 0 1 2.25 2.25v7.5" />,
    <path key="confirm" strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />,
  ];
  const steps = archetype.steps.map((s, i) => ({ n: String(i + 1), t: s.t, d: s.d, icon: stepIcons[i] }));

  const ctx: SiteRenderContext = {
    site,
    settings,
    shopSlug,
    services,
    filteredServices,
    categories,
    category,
    setCategory,
    staff,
    sortedReviews,
    reviewCount,
    hasAddress,
    hasVisitInfo,
    illustrativeContact: demo,
    galleryImages,
    hasSocialProof,
    statsRating,
    trustSignals,
    heroSubline,
    heroHeadline,
    heroTagline,
    heroSrc,
    aboutText,
    aboutHeading,
    bookLabel,
    pillars,
    steps,
    archetype,
    scrollToId,
  };

  // Middle sections keyed for per-archetype ordering. Each entry keeps its
  // original markup and conditional-render rule (team needs staff, reviews
  // need reviews, location needs an address) so it is null exactly when the
  // section would not have rendered before.
  // Which of the shop's own photos exist — decides whether the image-hungry v3
  // variants would render placeholder panels (blank squares) for this shop.
  // "every" vs "any" because showcase photographs every card while the
  // single-photo variants need only one. Uses the unfiltered service list
  // (not category-filtered) so the choice is stable across SSR/hydration.
  const everyServiceImaged = services.every((s) => trimMediaUrl(s.image_url).length > 0);
  const anyServiceImaged = services.some((s) => trimMediaUrl(s.image_url).length > 0);
  const hasHeroImage = heroSrc.length > 0;

  const rawSpec = site.design_spec;
  let v3Plan: RenderPlan | null = null;
  if ((site.design_version ?? 1) >= 3 && rawSpec && typeof rawSpec === "object") {
    // A stored spec is already normalized by the pipeline; normalize again on
    // read as belt-and-braces — a corrupt row falls back to the legacy path
    // rather than blanking the site.
    const { spec, fellBack } = normalizeDesignSpec(rawSpec, seedComposeDesignSpec(site.shop_id ?? "unknown"));
    v3Plan = fellBack.includes("all")
      ? null
      : downgradeForImages(composeRenderPlan(spec), { everyServiceImaged, anyServiceImaged, hasHeroImage });
  }
  // With no trust strip in the plan, the hero's small print is the only place
  // the shop's factual signals can appear.
  if (v3Plan && !v3Plan.sections.some((s) => s.key === "trust") && trustSignals.length > 0) {
    ctx.heroSubline = trustSignals.slice(0, 3).join(" · ");
  }

  const sections: Record<SectionKey, ReactNode> = {
    trust: <TrustSection ctx={ctx} />,
    services: <ServicesSection ctx={ctx} cols={archetype.servicesCols} glow={archetype.glow} />,
    about: <AboutSection ctx={ctx} pillarStyle={archetype.pillarStyle} />,
    team: <TeamSection ctx={ctx} />,
    how: <HowSection ctx={ctx} stepsStyle={archetype.stepsStyle} glow={archetype.glow} />,
    reviews: <ReviewsSection ctx={ctx} />,
    location: <LocationSection ctx={ctx} />,
  };

  // v3 dispatch: variant -> component + options. Unknown ids render the
  // section's standard component. The "how" variants map onto stepsStyle.
  const v3SectionNode = (key: SectionKey, variant: string, plan: RenderPlan): ReactNode => {
    switch (key) {
      case "trust":
        return variant === "chips" ? <TrustChipsSection ctx={ctx} density={plan.density} /> : <TrustSection ctx={ctx} />;
      case "services":
        return variant === "rows" ? (
          <ServicesRowsSection ctx={ctx} density={plan.density} glow={plan.glow} />
        ) : variant === "showcase" ? (
          <ServicesShowcaseSection ctx={ctx} density={plan.density} glow={plan.glow} />
        ) : (
          <ServicesSection ctx={ctx} cols={3} glow={plan.glow} />
        );
      case "about":
        return variant === "split-image" ? (
          <AboutSplitImageSection ctx={ctx} density={plan.density} />
        ) : variant === "story" ? (
          <AboutStorySection ctx={ctx} density={plan.density} />
        ) : (
          <AboutSection ctx={ctx} pillarStyle="icons" />
        );
      case "team":
        return variant === "strip" ? <TeamStripSection ctx={ctx} density={plan.density} /> : <TeamSection ctx={ctx} />;
      case "how":
        return <HowSection ctx={ctx} stepsStyle={variant === "row" ? "row" : "grid"} glow={plan.glow} />;
      case "reviews":
        return variant === "marquee" ? (
          <ReviewsMarqueeSection ctx={ctx} density={plan.density} animate={plan.reveal !== null} />
        ) : variant === "spotlight" ? (
          <ReviewsSpotlightSection ctx={ctx} density={plan.density} />
        ) : (
          <ReviewsSection ctx={ctx} />
        );
      case "location":
        return variant === "map-first" ? <LocationMapFirstSection ctx={ctx} density={plan.density} /> : <LocationSection ctx={ctx} />;
    }
  };

  const v3Hero = (plan: RenderPlan): ReactNode => {
    const motionClass = plan.hero.motion === "fade" ? "st-hero-fade" : "";
    const parallax = plan.hero.motion === "parallax";
    switch (plan.hero.variant) {
      case "split":
        return <HeroSplitSection ctx={ctx} density={plan.density} motif={plan.motif} motionClass={motionClass} parallax={parallax} />;
      case "editorial":
        return <HeroEditorialSection ctx={ctx} density={plan.density} motif={plan.motif} motionClass={motionClass} parallax={parallax} />;
      case "minimal":
        return <HeroMinimalSection ctx={ctx} density={plan.density} motif={plan.motif} motionClass={motionClass} />;
      default:
        return <HeroSection ctx={ctx} centered={plan.hero.centered} minH={plan.hero.minH} motionClass={motionClass} parallax={parallax} />;
    }
  };

  // A wrapped-but-empty reveal div would still animate; skip sections that
  // will render null (same conditions the components enforce internally).
  const sectionHasContent = (key: SectionKey): boolean =>
    key === "team"
      ? staff.length > 0
      : key === "reviews"
        ? sortedReviews.length > 0
        : key === "location"
          ? hasVisitInfo
          : true;

  // Signature imagery: the generated "space" photos when the site has a set.
  // The hero and service photos are only the fallback pool for sites made
  // before galleries existed; mixing them in repeated photos the visitor had
  // just seen in the hero and the menu. Deduped, order-stable.
  const signatureImages = Array.from(
    new Set(
      (galleryImages.length >= 3
        ? galleryImages
        : [...galleryImages, heroSrc, ...services.map((s) => (typeof s.image_url === "string" ? s.image_url : ""))]
      )
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  );

  // A shop with its own gallery photos always shows them. When the composed
  // signature is the gallery they ARE the signature; otherwise they follow
  // the about section (or lead into the signature when about is excluded), so
  // every supported composition keeps its own showpiece.
  const spaceNode = (plan: { density: RenderPlan["density"]; motif: RenderPlan["motif"] }): ReactNode =>
    galleryImages.length >= 3 ? (
      <SignatureGallerySection ctx={ctx} images={galleryImages} density={plan.density} motif={plan.motif} />
    ) : null;

  const v3SignatureNode = (plan: RenderPlan): ReactNode => {
    switch (plan.signature) {
      case "gallery":
        return signatureImages.length >= 3 ? (
          <SignatureGallerySection ctx={ctx} images={signatureImages} density={plan.density} motif={plan.motif} />
        ) : null;
      case "marquee-reviews":
        return sortedReviews.length > 0 ? (
          <ReviewsMarqueeSection ctx={ctx} density={plan.density} animate={plan.reveal !== null} heading="What clients say" />
        ) : null;
      case "spotlight":
        return services.length > 0 ? (
          <SignatureSpotlightSection ctx={ctx} density={plan.density} motif={plan.motif} animate={plan.reveal !== null} />
        ) : null;
      default:
        return null;
    }
  };

  return (
    <CommercialShopChrome site={site} settings={settings} shopSlug={shopSlug} services={services} staff={staff} homeActive>
      {v3Plan ? (
        (() => {
          const plan = v3Plan;
          const visible = plan.sections.filter((p) => sectionHasContent(p.key));
          const enabled = plan.reveal !== null;
          const lively = plan.reveal?.intensity === "lively";
          const style = plan.reveal?.style ?? "fade-up";
          const space = plan.signature === "gallery" ? null : spaceNode(plan);
          const spaceAfterAbout = space !== null && visible.some((p) => p.key === "about");
          const body = (
            <>
              {v3Hero(plan)}
              {visible.map((p, i) => (
                <Fragment key={p.key}>
                  <Reveal enabled={enabled} style={style} index={i} lively={lively}>
                    {v3SectionNode(p.key, p.variant, plan)}
                  </Reveal>
                  {spaceAfterAbout && p.key === "about" ? (
                    <Reveal enabled={enabled} style={style} index={i} lively={lively}>
                      {space}
                    </Reveal>
                  ) : null}
                </Fragment>
              ))}
              {space !== null && !spaceAfterAbout ? (
                <Reveal enabled={enabled} style={style} index={visible.length} lively={lively}>
                  {space}
                </Reveal>
              ) : null}
              {(() => {
                const sig = v3SignatureNode(plan);
                return sig ? (
                  <Reveal enabled={enabled} style={style} index={visible.length} lively={lively}>
                    {sig}
                  </Reveal>
                ) : null;
              })()}
              <Reveal enabled={enabled} style={style} index={visible.length + 1} lively={lively}>
                <FinalCtaSection ctx={ctx} glow={plan.glow} />
              </Reveal>
            </>
          );
          return plan.reveal ? (
            <div className={`st-motion-${plan.reveal.intensity}`}>{body}</div>
          ) : (
            body
          );
        })()
      ) : (
        <>
          <HeroSection ctx={ctx} centered={heroCentered} minH={archetype.heroMinH} />
          {/* Middle sections in the archetype's order */}
          {archetype.order.map((key) => (
            <Fragment key={key}>
              {sections[key]}
              {key === "about" ? spaceNode({ density: "airy", motif: "none" }) : null}
            </Fragment>
          ))}
          <FinalCtaSection ctx={ctx} glow={archetype.glow} />
        </>
      )}
    </CommercialShopChrome>
  );
}
