/** The developer dashboard's "Send a test alert" (routes/api.dev.alert-test.tsx). */

export const ALERT_TEST_PATH = "/api/dev/alert-test";

export type AlertTestOutcome = "raised" | "refused" | "unreachable";

/**
 * A developer's POST always throws, so Remix answers 500 and the error is on
 * its way to the alert email. Anything else (a sign-in redirect, read as 0
 * under redirect: "manual") means it was not raised. null: no response.
 */
export function alertTestOutcome(status: number | null): AlertTestOutcome {
  if (status === null) return "unreachable";
  return status === 500 ? "raised" : "refused";
}

export const ALERT_TEST_MESSAGE: Record<AlertTestOutcome, string> = {
  raised: "Test error raised. The alert email should reach you within a few minutes.",
  refused: "The test error was not raised. Sign in again as a developer and retry.",
  unreachable: "The website could not be reached. Check your connection and retry.",
};
