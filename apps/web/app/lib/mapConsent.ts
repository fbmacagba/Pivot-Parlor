import { useEffect, useState } from "react";

// The visitor's cookie choice on shop pages (PECR). Shops set only strictly
// necessary cookies of their own; the one optional item is the Google map,
// whose iframe lets Google set cookies, so it loads only after the visitor
// allows it (the shop cookie notice's "Allow map", or a map's "Show map").
//
// One localStorage record holds the choice: { essential, maps?, timestamp }.
// A record without `maps` (the notice before maps were asked about) is
// undecided about the map.

export type MapConsent = "granted" | "declined";

export const SHOP_CONSENT_KEY = "pp_cookie_consent";
/** Fired on window when the choice changes, so maps already on the page follow it. */
export const MAP_CONSENT_EVENT = "pp:map-consent";

function readRecord(): { maps?: unknown } | null {
  try {
    const raw = localStorage.getItem(SHOP_CONSENT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as { maps?: unknown }) : null;
  } catch {
    return null;
  }
}

export function readMapConsent(): MapConsent | null {
  const maps = readRecord()?.maps;
  return maps === "granted" || maps === "declined" ? maps : null;
}

/**
 * Records that the notice was acknowledged. `maps` is the map choice; null
 * (the plain notice on a shop without a map) keeps any earlier map choice.
 */
export function recordShopConsent(maps: MapConsent | null): void {
  const kept = maps ?? readMapConsent();
  try {
    localStorage.setItem(
      SHOP_CONSENT_KEY,
      JSON.stringify({ essential: true, ...(kept ? { maps: kept } : {}), timestamp: new Date().toISOString() }),
    );
  } catch {
    /* private browsing: the choice lasts only for this page */
  }
  window.dispatchEvent(new CustomEvent(MAP_CONSENT_EVENT, { detail: kept }));
}

/**
 * The current map choice. Null on the server and on the first client render
 * (the server never sends the map), then the stored choice, kept current as
 * the visitor changes it here or in another tab.
 */
export function useMapConsent(): MapConsent | null {
  const [consent, setConsent] = useState<MapConsent | null>(null);
  useEffect(() => {
    const sync = (event?: Event) => {
      const detail = (event as CustomEvent<MapConsent | null> | undefined)?.detail;
      setConsent(detail === "granted" || detail === "declined" ? detail : readMapConsent());
    };
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.key === SHOP_CONSENT_KEY) sync();
    };
    window.addEventListener(MAP_CONSENT_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(MAP_CONSENT_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return consent;
}
