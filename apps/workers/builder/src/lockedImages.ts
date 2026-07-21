export interface LockedImages {
  hero?: boolean;
  logo?: boolean;
}

/** Parse shop_sites.locked_images_json into flags; tolerant of NULL/garbage. */
export function parseLockedImages(json: string | null | undefined): LockedImages {
  if (!json) return {};
  try {
    const o = JSON.parse(json) as Record<string, unknown>;
    return { hero: o.hero === true, logo: o.logo === true };
  } catch {
    return {};
  }
}

/**
 * Decide hero/logo urls to persist on regenerate: a locked slot keeps its
 * EXISTING url (owner/developer customisation survives); an unlocked slot takes
 * the freshly generated url. The fresh-INSERT path passes no existing row and
 * empty locks, so it takes all generated.
 */
export function resolveRegeneratedImageUrls(args: {
  existingHero: string | null;
  existingLogo: string | null;
  generatedHero: string | null;
  generatedLogo: string | null;
  locked: LockedImages;
}): { hero: string | null; logo: string | null } {
  return {
    hero: args.locked.hero ? args.existingHero : args.generatedHero,
    logo: args.locked.logo ? args.existingLogo : args.generatedLogo,
  };
}
