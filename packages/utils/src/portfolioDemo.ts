/** This exact shop is reserved for the owner's public portfolio demonstration.
 * This is code-owned configuration, never a request-supplied demo switch. */
export const PORTFOLIO_DEMO_SLUG = "ferdyms-barber-shop-014";
export const PORTFOLIO_DEMO_ID = "portfolio-demo-ferdyms";
export const PORTFOLIO_DEMO_ERROR =
  "This demonstration shop does not accept real bookings, payments or queue submissions.";

export function isPortfolioDemoShop(slug: string | null | undefined): boolean {
  return slug === PORTFOLIO_DEMO_SLUG;
}

/** Explicitly scripted sample replies. No model, network call or storage. */
export function portfolioDemoReply(message: string): string {
  if (/price|cost|service|haircut|clipper|restyle/i.test(message)) {
    return "Example services: Classic haircut £25 (30 min), Clipper cut £12 (30 min), and Restyle & finish £30 (45 min). Try the demo booking to explore the next steps. No real appointment is made.";
  }
  if (/staff|barber|team|who/i.test(message)) {
    return "Alex Morgan and Jamie Lee are illustrative team members in this demonstration. You can choose either in the demo booking.";
  }
  if (/time|slot|book|available|appointment/i.test(message)) {
    return "Choose a service, a sample team member and a date in the demo booking. The times are illustrative, and completing the walkthrough reserves nothing.";
  }
  return "This is a scripted portfolio demonstration. Ask about the example services, prices or team, or try a demo booking. Please do not enter personal details.";
}
