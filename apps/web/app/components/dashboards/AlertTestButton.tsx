import { useState } from "react";
import { Button } from "~/components/ui/Button";
import { ALERT_TEST_MESSAGE, ALERT_TEST_PATH, alertTestOutcome, type AlertTestOutcome } from "~/lib/alertTest";

/** Raises one labelled server error so the owner can confirm alerts still arrive. */
export function AlertTestButton() {
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<AlertTestOutcome | null>(null);

  async function send() {
    setSending(true);
    setOutcome(null);
    let status: number | null = null;
    try {
      const res = await fetch(ALERT_TEST_PATH, { method: "POST", redirect: "manual" });
      status = res.status;
    } catch {
      status = null;
    }
    setOutcome(alertTestOutcome(status));
    setSending(false);
  }

  return (
    <section className="mt-10 rounded-xl border border-white/10 bg-dark-100 p-5">
      <h2 className="font-heading text-lg font-semibold text-white">Alert check</h2>
      <p className="mt-1 max-w-prose text-sm text-white/60">
        Raises one labelled server error on the website, so you can confirm the alert email still
        reaches you. Nothing else changes.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="button" variant="secondary" size="sm" onClick={send} disabled={sending}>
          {sending ? "Sending…" : "Send a test alert"}
        </Button>
        <p role="status" aria-live="polite" className="text-sm text-white/70">
          {outcome ? ALERT_TEST_MESSAGE[outcome] : null}
        </p>
      </div>
    </section>
  );
}
