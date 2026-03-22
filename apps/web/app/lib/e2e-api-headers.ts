/**
 * E2E cookies → Worker API headers (Remix loaders/actions run on the server, so
 * Playwright page.route() cannot intercept fetches to API_URL).
 *
 * Set cookies from Playwright before navigation:
 * - e2e_stripe_shop_list=1 → mock unpaid shop row for Stripe UI tests
 * - e2e_legacy_onboard=1 → skip Stripe on POST /api/shops; return invite flow
 * - e2e_invite_mock=1 → enable invite GET mocks (e.g. inactive token) on invite routes
 */
export function apiE2eHeadersFromCookieHeader(cookieHeader: string | null): Record<string, string> | undefined {
  const c = cookieHeader ?? "";
  const h: Record<string, string> = {};
  if (/\be2e_stripe_shop_list=1\b/.test(c)) h["X-E2E-Test-Mock-Stripe-List"] = "1";
  if (/\be2e_legacy_onboard=1\b/.test(c)) h["X-E2E-Test-Mock"] = "1";
  return Object.keys(h).length ? h : undefined;
}

export function invitePageSendsE2eMock(request: Request): boolean {
  return /\be2e_invite_mock=1\b/.test(request.headers.get("Cookie") ?? "");
}
