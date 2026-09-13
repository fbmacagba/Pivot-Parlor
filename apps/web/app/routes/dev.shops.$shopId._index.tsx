import { Link, useFetcher, useNavigate, useOutletContext, useRevalidator } from "@remix-run/react";
import { Check, Loader2, Sparkles, Trash2, UserCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "~/components/ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
import { RegenStepRow } from "~/components/dev-shops/RegenStepRow";
import { COLOR_PALETTES } from "~/lib/color-palettes";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  REGEN_STEP_LABELS,
  pickerModelsFrom,
} from "~/components/dev-shops/constants";
import { buildRegeneratePayload, decidePollAction, regenJobStepStates } from "~/components/dev-shops/helpers";
import { VisualManager, type VisualsData } from "~/components/VisualManager";
import type { Shop } from "~/components/dev-shops/types";
import type { AIModel } from "@repo/types";
import type { DevGenerationPrefs, DevShopOwnerDetails } from "./dev.shops.$shopId";

type OutletCtx = {
  shop: Shop;
  apiUrl: string;
  generationPrefs: DevGenerationPrefs;
  ownerDetails: DevShopOwnerDetails | null;
  visuals: VisualsData | null;
  models: AIModel[] | null;
};

export default function DevShopDetailIndex() {
  const { shop, apiUrl, generationPrefs, ownerDetails, visuals, models } = useOutletContext<OutletCtx>();
  const textPickerModels = pickerModelsFrom(models, "text");
  const imagePickerModels = pickerModelsFrom(models, "image");
  const revalidator = useRevalidator();
  const navigate = useNavigate();

  // ── Configure ──────────────────────────────────────────────────────────────
  const [designNotes, setDesignNotes] = useState(generationPrefs.design_notes ?? "");
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [textEffort, setTextEffort] = useState("");
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [composer, setComposer] = useState("ai");
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [includeImages, setIncludeImages] = useState(true);
  const selectedPalette = paletteId ? COLOR_PALETTES.find((p) => p.id === paletteId) ?? null : null;

  // ── Regenerate flow ──────────────────────────────────────────────────────────
  const [genBusy, setGenBusy] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genJobId, setGenJobId] = useState<string | null>(null);
  const [genPoll, setGenPoll] = useState<{ status: string; stage: string; error?: string } | null>(null);

  // Reusing images requires the shop to already have them.
  const hasHero = Boolean(shop.hero_image_url);
  const hasLogo = Boolean(shop.logo_url);
  const reuseBlocked = !includeImages && (!hasHero || !hasLogo);

  async function handleRegenerate() {
    if (reuseBlocked || genBusy || genJobId) return;
    setGenError(null);
    setGenPoll(null);
    setGenJobId(null);
    setGenBusy(true);
    try {
      // 1) Persist the chosen models/notes/composer (same KV the pipeline reads).
      const sRes = await fetch(`/api/shops/${shop.id}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          design_notes: designNotes,
          text_model: textModel,
          text_effort: textEffort,
          image_model: imageModel,
          composer,
        }),
      });
      const sJson = (await sRes.json().catch(() => ({}))) as { ok?: boolean; success?: boolean; error?: string };
      if (!sRes.ok || sJson.ok === false || sJson.success === false) {
        setGenError(sJson.error?.trim() || "Could not save settings.");
        setGenBusy(false);
        return;
      }
      // 2) Kick off generation with the palette + include-images choice.
      const gRes = await fetch(`/api/shops/${shop.id}/generate-site`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildRegeneratePayload({ includeImages, palette: selectedPalette })),
      });
      const gJson = (await gRes.json().catch(() => ({}))) as { data?: { jobId?: string }; error?: string };
      const jobId = gJson.data?.jobId;
      if (!gRes.ok || !jobId) {
        setGenError(gJson.error?.trim() || "Could not start generation.");
        setGenBusy(false);
        return;
      }
      setGenJobId(jobId); // starts the poller
    } catch {
      setGenError("Could not reach the server. Please try again.");
      setGenBusy(false);
    }
  }

  // Poll the job with the shared failure floor so the bar always resolves.
  useEffect(() => {
    if (!genJobId) return;
    let cancelled = false;
    const jobId = genJobId;
    const startedAt = Date.now();
    let failures = 0;
    let iv: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      if (iv !== undefined) {
        clearInterval(iv);
        iv = undefined;
      }
    };
    const tick = async () => {
      let data: { status?: string; stage?: string; error?: string } | undefined;
      try {
        const r = await fetch(`/api/jobs/${jobId}/status`, { cache: "no-store" });
        const j = (await r.json()) as {
          success?: boolean;
          data?: { status?: string; stage?: string; error?: string };
        };
        if (cancelled) return;
        if (j.success && j.data) data = j.data;
      } catch {
        /* network/parse failure → counts as a failed poll below */
      }
      if (cancelled) return;

      const ok = data !== undefined;
      failures = ok ? 0 : failures + 1;
      const decision = decidePollAction({
        ok,
        status: data?.status ?? "",
        stage: data?.stage ?? "",
        elapsedMs: Date.now() - startedAt,
        consecutiveFailures: failures,
      });
      if (ok) {
        setGenPoll({ status: data!.status ?? "", stage: data!.stage ?? "", error: data!.error ?? undefined });
      }
      switch (decision.kind) {
        case "terminal":
          stop();
          setGenBusy(false);
          if ((data?.status ?? "") !== "failed") {
            setGenJobId(null);
            revalidator.revalidate(); // pull the regenerated copy/images into the page
          }
          break;
        case "stalled":
        case "give-up":
          setGenPoll((prev) => ({
            status: "failed",
            stage: prev?.stage ?? data?.stage ?? "",
            error: decision.message,
          }));
          stop();
          setGenBusy(false);
          break;
        // "update" | "keep-going": keep polling.
      }
    };
    void tick();
    iv = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- revalidator is stable; only the job id matters
  }, [genJobId]);

  const pollStatus = (genPoll?.status ?? "").toLowerCase();
  const pollStage = (genPoll?.stage ?? "").toLowerCase();
  const optimistic = genBusy && !genPoll;
  const stepStates = regenJobStepStates(
    optimistic ? "queued" : pollStatus,
    optimistic ? "research" : pollStage || "research",
  );
  const jobComplete = pollStatus === "complete" || pollStage === "complete" || pollStage === "done";
  const jobFailed = pollStatus === "failed";
  const running = Boolean(genJobId) || genBusy;
  const showProgress = running || jobComplete || jobFailed;

  // ── Owner + delete ───────────────────────────────────────────────────────────
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const deleteShopFetcher = useFetcher<{ success?: boolean; error?: string }>();

  useEffect(() => {
    if (deleteShopFetcher.state !== "idle" || !deleteShopFetcher.data?.success) return;
    setDeleteDialogOpen(false);
    navigate("/dev/shops");
  }, [deleteShopFetcher.state, deleteShopFetcher.data, navigate]);

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex flex-wrap gap-2">
        <Dialog open={ownerDialogOpen} onOpenChange={setOwnerDialogOpen}>
          <DialogTrigger asChild>
            <Button type="button" variant="secondary" size="sm">
              <UserCircle className="mr-2 h-4 w-4" />
              Shop owner details
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Shop owner &amp; platform users</DialogTitle>
            </DialogHeader>
            {ownerDetails ? (
              <div className="space-y-4 text-sm">
                <div className="rounded-lg border border-white/10 bg-white/[0.03] p-4">
                  <dl className="space-y-2">
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Owner name</dt>
                      <dd className="text-white">{ownerDetails.owner_name?.trim() || "—"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Owner email</dt>
                      <dd className="break-all text-white">{ownerDetails.owner_email?.trim() || "—"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Shop phone</dt>
                      <dd className="text-white">{ownerDetails.phone?.trim() || "—"}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/60">
                    Platform users
                  </h3>
                  {ownerDetails.platform_users.length === 0 ? (
                    <p className="text-white/50">No linked platform users yet.</p>
                  ) : (
                    <div className="overflow-x-auto rounded-lg border border-white/10">
                      <table className="w-full text-left text-xs">
                        <thead>
                          <tr className="border-b border-white/10 bg-white/[0.03]">
                            <th className="px-3 py-2 font-medium text-white/50">Role</th>
                            <th className="px-3 py-2 font-medium text-white/50">Name</th>
                            <th className="px-3 py-2 font-medium text-white/50">Email</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {ownerDetails.platform_users.map((u) => (
                            <tr key={u.id}>
                              <td className="px-3 py-2 capitalize text-white/90">{u.role}</td>
                              <td className="px-3 py-2 text-white/80">{u.name ?? "—"}</td>
                              <td className="px-3 py-2 break-all text-white/70">{u.email}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-sm text-white/55">Could not load owner details. Refresh the page or try again.</p>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* ── Configure & regenerate ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gold/30 bg-gold/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Configure &amp; regenerate</h2>
        <p className="mt-1 text-sm text-white/50">
          Set the design brief, models, and palette, then regenerate the site. Progress shows below.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/80">Design notes</label>
            <textarea
              value={designNotes}
              onChange={(e) => setDesignNotes(e.target.value)}
              rows={4}
              disabled={running}
              className="w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
              placeholder="Style and content hints for the pipeline…"
            />
          </div>

          <ModelPicker
            label="Text & research"
            models={textPickerModels}
            value={textModel}
            onChange={setTextModel}
            effort={textEffort}
            onEffortChange={setTextEffort}
            disabled={running}
          />
          <p className="-mt-1 text-xs text-white/50">
            {textPickerModels.some((m) => m.livePricing)
              ? "Live pricing, refreshed hourly."
              : "Price feed unreachable, showing last-known pricing."}
          </p>
          <ModelPicker
            label="Image"
            models={imagePickerModels}
            value={imageModel}
            onChange={setImageModel}
            disabled={running}
          />

          <div>
            <label className="mb-1.5 block text-sm font-medium text-white/80">Site composer</label>
            <select
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              disabled={running}
              className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
            >
              <option value="ai" className="bg-dark">AI design director (default)</option>
              <option value="seed" className="bg-dark">Deterministic seed</option>
            </select>
          </div>

          {/* Palette */}
          <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Colour palette</h3>
              <span className="text-xs text-white/60">{selectedPalette ? selectedPalette.name : "Auto (AI picks)"}</span>
            </div>
            <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Colour palette">
              <button
                type="button"
                role="radio"
                aria-checked={selectedPalette === null}
                disabled={running}
                onClick={() => setPaletteId(null)}
                className={`col-span-4 flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                  selectedPalette === null
                    ? "border-gold text-white ring-2 ring-gold/40"
                    : "border-white/15 text-white/70 hover:border-white/35"
                }`}
              >
                <Sparkles className="h-4 w-4 shrink-0 text-gold" />
                <span className="flex-1">Let AI choose the palette</span>
                {selectedPalette === null ? <Check className="h-4 w-4 shrink-0 text-gold" /> : null}
              </button>
              {COLOR_PALETTES.map((p) => {
                const isSel = p.id === paletteId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={isSel}
                    aria-label={p.name}
                    title={p.name}
                    disabled={running}
                    onClick={() => setPaletteId(p.id)}
                    className={`relative flex aspect-square flex-col overflow-hidden rounded-lg border transition-colors ${
                      isSel ? "border-gold ring-2 ring-gold/40" : "border-white/15 hover:border-white/35"
                    }`}
                  >
                    <span className="flex-1" style={{ background: p.primary }} />
                    <span className="h-2.5 w-full" style={{ background: p.accent }} />
                    {isSel ? (
                      <span className="absolute right-1 top-1 rounded-full bg-gold p-0.5 text-black">
                        <Check className="h-3 w-3" />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Include images + action */}
          <label className="flex w-fit cursor-pointer select-none items-start gap-2.5 text-sm text-white/80">
            <input
              type="checkbox"
              checked={includeImages}
              disabled={running}
              onChange={(e) => setIncludeImages(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-gold"
            />
            <span>
              Generate new images (hero, logo, service photos)
              <span className="ml-1 text-white/45">— slower, 1–3 min. Uncheck to reuse the current images.</span>
            </span>
          </label>

          {reuseBlocked ? (
            <p className="text-xs text-amber-300/80">
              This shop has no saved hero/logo yet, so images must be generated. Tick the box above (or upload them below).
            </p>
          ) : null}

          {genError ? (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {genError}
            </div>
          ) : null}

          <Button type="button" className="min-h-12" disabled={running || reuseBlocked} onClick={handleRegenerate}>
            {running ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {genBusy && !genPoll ? "Starting…" : "Generating…"}
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" /> Regenerate site
              </>
            )}
          </Button>

          {showProgress ? (
            <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
              <ol className="list-none space-y-2 p-0" aria-label="Generation progress">
                {REGEN_STEP_LABELS.map((label, i) => (
                  <RegenStepRow key={label} label={label} state={stepStates[i]!} index={i} />
                ))}
              </ol>
              {jobComplete ? (
                <p className="mt-3 text-sm text-emerald-300">Done. The updated site is live.</p>
              ) : null}
              {jobFailed ? (
                <p className="mt-3 text-sm text-red-300">{genPoll?.error ?? "Generation failed."}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>

      {/* ── Visuals (logo, hero, per-service photos) ──────────────────────────── */}
      {visuals ? (
        <VisualManager role="developer" shopId={shop.id} apiUrl={apiUrl} {...visuals} />
      ) : (
        <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-lg font-semibold text-white">Visuals</h2>
          <p className="mt-1 text-sm text-white/50">Visuals are unavailable for this shop right now.</p>
        </section>
      )}

      {/* ── Danger zone ─────────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-red-200/90">Danger zone</h2>
        <p className="mt-1 text-sm text-white/60">
          Permanently delete this shop and related records. This cannot be undone.
        </p>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-4 text-red-400 hover:bg-red-500/10 hover:text-red-300"
          onClick={() => setDeleteDialogOpen(true)}
        >
          <Trash2 className="mr-2 h-4 w-4" />
          Delete shop…
        </Button>
        <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete this shop?</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-white/65">
              This will remove <span className="font-medium text-white">{shop.name}</span> ({shop.slug}) and related
              data. Confirm to proceed.
            </p>
            {deleteShopFetcher.data &&
            typeof deleteShopFetcher.data === "object" &&
            "error" in deleteShopFetcher.data &&
            typeof (deleteShopFetcher.data as { error?: string }).error === "string" ? (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {(deleteShopFetcher.data as { error: string }).error}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteDialogOpen(false)}>
                Cancel
              </Button>
              <deleteShopFetcher.Form method="post" action={`/api/shops/${shop.id}/delete`}>
                <Button
                  type="submit"
                  size="sm"
                  className="bg-red-600 hover:bg-red-500"
                  disabled={deleteShopFetcher.state !== "idle"}
                >
                  {deleteShopFetcher.state !== "idle" ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Deleting…
                    </>
                  ) : (
                    <>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete permanently
                    </>
                  )}
                </Button>
              </deleteShopFetcher.Form>
            </div>
          </DialogContent>
        </Dialog>
      </section>

      <p className="text-sm text-white/60">
        <Link to="/dev/shops" className="text-gold hover:underline">
          Back to shops list
        </Link>
        {" · "}
        <a
          href={`https://pivotparlor.com/${shop.slug}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-gold hover:underline"
        >
          View live site
        </a>
      </p>
    </div>
  );
}
