import { Link, useLoaderData, useOutletContext } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { useEffect, useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import type { DevShopDetail } from "./dev.shops.$shopId";

export async function loader({ params }: LoaderFunctionArgs) {
  const shopId = params.shopId!;
  const jobId = params.jobId!;
  if (!shopId || !jobId) throw new Response("Not found", { status: 404 });
  return json({ shopId, jobId });
}

type JobPayload = {
  success?: boolean;
  data?: { status?: string; stage?: string; shopSlug?: string; error?: string };
  error?: string;
};

export default function DevShopGenerationStatus() {
  const { shopId, jobId } = useLoaderData<typeof loader>();
  const outlet = useOutletContext<{ shop: DevShopDetail } | undefined>();
  const shop = outlet?.shop;

  const [stage, setStage] = useState<string>("");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [doneSlug, setDoneSlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/status`);
        const j = (await r.json()) as JobPayload;
        if (cancelled) return;
        if (!j.success || !j.data) {
          setError(j.error ?? "Status request failed");
          return;
        }
        const { status: st, stage: sg, shopSlug, error: err } = j.data;
        setStage(sg ?? "");
        setStatus(st ?? "");
        if (st === "failed" || sg === "failed") {
          setError(err ?? "Generation failed");
          return;
        }
        if (sg === "done" || st === "complete") {
          setDoneSlug(shopSlug ?? shop?.slug ?? null);
        }
      } catch {
        if (!cancelled) setError("Could not load job status");
      }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [jobId, shop?.slug]);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link to={`/dev/shops/${shopId}`} className="text-sm text-gold hover:underline">
          ← Shop detail
        </Link>
      </div>

      <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Site generation status</h2>
        <p className="mt-1 font-mono text-xs text-white/60">Job {jobId}</p>

        {error ? (
          <div className="mt-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            {error}
          </div>
        ) : doneSlug ? (
          <div className="mt-4 rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
            Pipeline finished.{" "}
            <a
              href={`https://pivotparlor.com/${doneSlug}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-gold hover:underline"
            >
              View site <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-3 text-sm text-gold">
            <Loader2 className="h-5 w-5 animate-spin shrink-0" />
            <div>
              <p className="font-medium">Generation in progress…</p>
              <p className="mt-1 text-xs text-white/50">
                Stage: {stage || "…"} · Status: {status || "…"}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
