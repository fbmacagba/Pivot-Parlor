import { useFetcher } from "@remix-run/react";
import { ExternalLink, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/Button";
import { formatMadeAt } from "~/lib/siteCandidate";
import type { SiteCandidateSummary } from "~/routes/api.shops.$shopId.site-candidate";

/**
 * Owner review for a regenerated live site (migration 049). A regeneration of
 * a live or paused site waits here instead of replacing the public site.
 * Shown on the developer's shop page and the shop admin's overview; renders
 * nothing while no version is waiting.
 */

type LoadResult =
  | { success: true; data: SiteCandidateSummary }
  | { success: false; error: string; none?: true };
type ActResult = { success: true; intent: "publish" | "discard" } | { success: false; error: string };
type Notice = { tone: "ok" | "error"; text: string };

export function SiteCandidatePanel(props: {
  candidate: SiteCandidateSummary | null;
  previewHref: string;
  busy: "publish" | "discard" | null;
  confirmingDiscard: boolean;
  notice: Notice | null;
  onPublish: () => void;
  onDiscard: () => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  const { candidate, previewHref, busy, confirmingDiscard, notice } = props;
  const status = notice ? (
    <p
      role={notice.tone === "error" ? "alert" : "status"}
      className={`text-sm ${notice.tone === "error" ? "text-red-200" : "text-emerald-300"}`}
    >
      {notice.text}
    </p>
  ) : null;

  if (!candidate) {
    if (!status) return null;
    // An error needs its context; a "Published"/"Discarded" line carries its own.
    return notice?.tone === "error" ? (
      <section aria-labelledby="site-candidate-heading" className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 id="site-candidate-heading" className="font-heading text-lg font-semibold text-white">
          New version of your site
        </h2>
        <div className="mt-1" aria-live="polite">
          {status}
        </div>
      </section>
    ) : (
      <div aria-live="polite">{status}</div>
    );
  }

  const madeAt = formatMadeAt(candidate.created_at);
  const blocked = !candidate.services_unchanged;

  return (
    <section
      aria-labelledby="site-candidate-heading"
      className="rounded-xl border border-gold/40 bg-dark-100 p-6"
    >
      <h2 id="site-candidate-heading" className="font-heading text-lg font-semibold text-white">
        A new version of your site is ready
      </h2>
      <p className="mt-1 max-w-prose text-sm text-white/70">
        {madeAt ? `Made ${madeAt}. ` : ""}Your live site has not changed. Preview the new version, then publish it
        or discard it.
      </p>

      {blocked ? (
        <p className="mt-3 max-w-prose rounded-lg border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          Your services changed after this version was made, so its service photos would land on the wrong services.
          Regenerate the site to get a matching version.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button asChild variant="secondary" className="min-h-11">
          <a href={previewHref} target="_blank" rel="noopener noreferrer">
            Preview
            <ExternalLink className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </Button>
        <Button
          type="button"
          className="min-h-11"
          disabled={blocked || busy !== null}
          onClick={props.onPublish}
        >
          {busy === "publish" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {busy === "publish" ? "Publishing" : "Publish"}
        </Button>
        {confirmingDiscard ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-white/80">Discard this version?</span>
            <Button
              type="button"
              variant="destructive"
              className="min-h-11"
              disabled={busy !== null}
              onClick={props.onConfirmDiscard}
            >
              {busy === "discard" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {busy === "discard" ? "Discarding" : "Discard"}
            </Button>
            <Button type="button" variant="ghost" className="min-h-11" disabled={busy !== null} onClick={props.onCancelDiscard}>
              Keep it
            </Button>
          </span>
        ) : (
          <Button type="button" variant="ghost" className="min-h-11" disabled={busy !== null} onClick={props.onDiscard}>
            Discard
          </Button>
        )}
      </div>

      {status ? (
        <div className="mt-3" aria-live="polite">
          {status}
        </div>
      ) : null}
    </section>
  );
}

export function SiteCandidateCard(props: {
  shopId: string;
  shopSlug: string;
  /** Bump to re-check, e.g. when a regeneration on the same page finishes. */
  refreshKey?: number;
}) {
  const { shopId, shopSlug, refreshKey = 0 } = props;
  const endpoint = `/api/shops/${encodeURIComponent(shopId)}/site-candidate`;
  const loadFetcher = useFetcher<LoadResult>();
  const actFetcher = useFetcher<ActResult>();
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  useEffect(() => {
    loadFetcher.load(endpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the fetcher is stable; reload on shop or refresh only
  }, [endpoint, refreshKey]);

  useEffect(() => {
    const result = actFetcher.data;
    if (actFetcher.state !== "idle" || !result) return;
    setConfirmingDiscard(false);
    if (result.success) {
      setNotice({
        tone: "ok",
        text:
          result.intent === "publish"
            ? "Published. Your site now shows the new version."
            : "Discarded. Your live site is unchanged.",
      });
    } else {
      setNotice({ tone: "error", text: result.error });
    }
    loadFetcher.load(endpoint);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to each finished submission only
  }, [actFetcher.state, actFetcher.data]);

  const loaded = loadFetcher.data;
  const candidate = loaded && loaded.success ? loaded.data : null;
  // A version that exists but cannot be shown (e.g. made by a newer release)
  // is worth saying; "nothing waiting" is the normal case and stays silent.
  const loadError: Notice | null =
    loaded && !loaded.success && !loaded.none ? { tone: "error", text: loaded.error } : null;
  const pending = actFetcher.state !== "idle" ? (actFetcher.formData?.get("intent") as "publish" | "discard" | null) : null;

  const submit = (intent: "publish" | "discard") => {
    if (!candidate) return;
    setNotice(null);
    actFetcher.submit({ intent, job_id: candidate.job_id }, { method: "post", action: endpoint });
  };

  return (
    <SiteCandidatePanel
      candidate={candidate}
      previewHref={`/${encodeURIComponent(shopSlug)}?preview=candidate`}
      busy={pending ?? null}
      confirmingDiscard={confirmingDiscard}
      notice={notice ?? loadError}
      onPublish={() => submit("publish")}
      onDiscard={() => setConfirmingDiscard(true)}
      onConfirmDiscard={() => submit("discard")}
      onCancelDiscard={() => setConfirmingDiscard(false)}
    />
  );
}
