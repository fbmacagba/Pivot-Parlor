import type { Bindings } from "../bindings.js";

/**
 * E2E mock/fixture paths must be opted into via the E2E_FIXTURES env var
 * (set only in dev/staging wrangler config, never production) AND the
 * per-request test header. A client header alone must never flip prod
 * behavior — before this gate, anyone could mint the well-known fixture
 * admin invite or skip the Stripe checkout flow by sending the header.
 */
export function e2eMockAllowed(env: Bindings, headerValue: string | undefined): boolean {
  return env.E2E_FIXTURES === "true" && headerValue === "1";
}
