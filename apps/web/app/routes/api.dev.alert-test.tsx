/**
 * POST /api/dev/alert-test: the developer dashboard's "Send a test alert".
 *
 * Raises one clearly labelled server error so the owner can confirm website
 * errors still reach the alert email (app/lib/serverErrors.ts reports it to
 * the API, whose log line becomes the email). It changes nothing else.
 * Developers only: anyone else is turned away before it throws.
 * docs/runbooks/production-alerting.md uses it as the firing control.
 *
 * A resource route: no default export, or Remix would answer with a page.
 */
import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { requireRole } from "~/lib/auth";

export class AlertTestError extends Error {
  constructor() {
    super("Deliberate test error from the developer dashboard");
    this.name = "AlertTestError";
  }
}

export async function action({ request, context }: ActionFunctionArgs): Promise<never> {
  const env = context.env as { API_URL: string };
  await requireRole(request, "developer", env.API_URL);
  throw new AlertTestError();
}
