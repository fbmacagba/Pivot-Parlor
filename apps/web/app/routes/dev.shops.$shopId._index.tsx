import { Link, useFetcher, useNavigate, useOutletContext, useRevalidator } from "react-router";
import { Check, ExternalLink, Loader2, Sparkles, Trash2, UserCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorScreen } from "~/components/ErrorScreen";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";
import { LoadError } from "~/components/ui/LoadError";
import { Select } from "~/components/ui/Select";
import { Textarea } from "~/components/ui/Textarea";
import { DeleteShopDialog } from "~/components/dev-shops/DeleteShopDialog";
import { ModelPicker } from "~/components/dev-shops/ModelPicker";
import { effortToSend } from "~/components/dev-shops/modelPicker.helpers";
import { RegenStepRow } from "~/components/dev-shops/RegenStepRow";
import { COLOR_PALETTES } from "~/lib/color-palettes";
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  REGEN_STEP_LABELS,
  pickerModelsFrom,
} from "~/components/dev-shops/constants";
import { buildRegeneratePayload, regenJobStepStates } from "~/components/dev-shops/helpers";
import { forgetJob, recallJob, rememberJob, useGenerationJob } from "~/components/dev-shops/useGenerationJob";
import { VisualManager, type VisualsData } from "~/components/VisualManager";
import { SiteCandidateCard } from "~/components/SiteCandidateCard";
import { withShopId } from "~/lib/pageShop";
import { pageTitle } from "~/lib/pageTitle";
import { useFetcherResult } from "~/lib/useFetcherResult";
import type { GenerateSiteActionResult, Shop } from "~/components/dev-shops/types";
import type { AIModel } from "@repo/types";
import type { DevGenerationPrefs, DevShopOwnerDetails } from "./dev.shops.$shopId";

export const meta = () => pageTitle("Shop");

export function ErrorBoundary() {
  return <ErrorScreen homeHref="/dev/shops" homeLabel="Back to shops" />;
}

type OutletCtx = {
  shop: Shop;
  apiUrl: string;
  publicOrigin: string;
  /** null when the saved settings could not be read. */
  generationPrefs: DevGenerationPrefs | null;
  ownerDetails: DevShopOwnerDetails | null;
  visuals: VisualsData | null;
  models: AIModel[] | null;
};

export default function DevShopDetailIndex() {
  const { shop, apiUrl, publicOrigin, generationPrefs, ownerDetails, visuals, models } =
    useOutletContext<OutletCtx>();
  const textPickerModels = pickerModelsFrom(models, "text");
  const imagePickerModels = pickerModelsFrom(models, "image");
  const revalidator = useRevalidator();
  const navigate = useNavigate();

  // ── Configure ──────────────────────────────────────────────────────────────
  const [designNotes, setDesignNotes] = useState(generationPrefs?.design_notes ?? "");
  const [textModel, setTextModel] = useState(DEFAULT_TEXT_MODEL);
  const [textEffort, setTextEffort] = useState("");
  const [imageModel, setImageModel] = useState(DEFAULT_IMAGE_MODEL);
  const [composer, setComposer] = useState("ai");
  const [paletteId, setPaletteId] = useState<string | null>(null);
  const [includeImages, setIncludeImages] = useState(true);
  const selectedPalette = paletteId ? COLOR_PALETTES.find((p) => p.id === paletteId) ?? null : null;

  // ── Regenerate flow ──────────────────────────────────────────────────────────
  const genFetcher = useFetcher<GenerateSiteActionResult>();
  const [savingSettings, setSavingSettings] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [genJobId, setGenJobId] = useState<string | null>(null);
  // True when the run being followed was not started by this click: it was
  // already going (another tab, or before a reload).
  const [followingExisting, setFollowingExisting] = useState(false);
  const [genPoll, setGenPoll] = useState<{ status: string; stage: string; error?: string; outcome?: string } | null>(null);
  // Re-check the review card when a regeneration on this page finishes.
  const [candidateRefresh, setCandidateRefresh] = useState(0);
  const starting = savingSettings || genFetcher.state !== "idle";

  // Reusing images requires the shop to already have them.
  const hasHero = Boolean(shop.hero_image_url);
  const hasLogo = Boolean(shop.logo_url);
  const reuseBlocked = !includeImages && (!hasHero || !hasLogo);

  const textModelName = textPickerModels.find((m) => m.id === textModel)?.name ?? textModel;
  const imageModelName = imagePickerModels.find((m) => m.id === imageModel)?.name ?? imageModel;
  const sentTextEffort = effortToSend(
    textPickerModels.find((m) => m.id === textModel),
    textEffort,
  );
  const siteStatus = shop.has_site ? (shop.website_status ?? "draft").toLowerCase() : "none";
  const sitePublic = siteStatus === "live" || siteStatus === "paused";

  // A run started before a reload, or in another tab of this browser, is
  // followed again as soon as the page opens.
  useEffect(() => {
    const saved = recallJob(shop.id);
    if (saved) {
      setFollowingExisting(true);
      setGenJobId(saved);
    }
  }, [shop.id]);

  async function startRegeneration() {
    if (reuseBlocked || starting || genJobId) return;
    setGenError(null);
    setGenPoll(null);
    setFollowingExisting(false);
    setSavingSettings(true);
    try {
      // 1) Persist the chosen models/notes/composer (same KV the pipeline reads).
      const sRes = await fetch(`/api/shops/${shop.id}/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          design_notes: designNotes,
          text_model: textModel,
          text_effort: sentTextEffort,
          image_model: imageModel,
          composer,
        }),
      });
      const sJson = (await sRes.json().catch(() => ({}))) as { ok?: boolean; success?: boolean; error?: string };
      if (!sRes.ok || sJson.ok === false || sJson.success === false) {
        setGenError(sJson.error?.trim() || "The settings could not be saved, so nothing was started. Please try again.");
        return;
      }
    } catch {
      setGenError("Could not reach the server, so nothing was started. Please try again.");
      return;
    } finally {
      setSavingSettings(false);
    }
    // 2) Start the run with the palette + include-images choice. It goes
    // through the shops list's action, which reads the server's "a run is
    // already going" answer and hands back that run's id to follow.
    const payload = buildRegeneratePayload({ includeImages, palette: selectedPalette });
    genFetcher.submit(
      {
        _action: "generate-site",
        shopId: shop.id,
        shopSlug: shop.slug,
        skip_images: payload.skip_images ? "1" : "",
        color_primary: payload.color_primary ?? "",
        color_accent: payload.color_accent ?? "",
      },
      { method: "post", action: "/dev/shops?index" },
    );
  }

  useFetcherResult(genFetcher, (answer) => {
    if (answer.success && answer.generateJobId) {
      setFollowingExisting(Boolean(answer.adopted));
      rememberJob(shop.id, answer.generateJobId);
      setGenJobId(answer.generateJobId); // starts following it
    } else {
      setGenError(answer.error?.trim() || "Generation could not be started. Please try again.");
    }
  });

  // Follow the job. Every ending, good or bad, clears the job id, so the
  // button is never left on "Generating…" and a retry needs no reload.
  useGenerationJob(genJobId, {
    onProgress: (s) => setGenPoll({ status: s.status, stage: s.stage, error: s.error, outcome: s.outcome }),
    onEnd: (end) => {
      forgetJob(shop.id);
      setGenJobId(null);
      if (end.kind === "failed") {
        setGenPoll((prev) => ({
          status: "failed",
          stage: end.snapshot?.stage || prev?.stage || "",
          error: end.message,
        }));
        return;
      }
      setGenPoll({
        status: end.snapshot.status || "complete",
        stage: end.snapshot.stage,
        outcome: end.snapshot.outcome,
      });
      revalidator.revalidate(); // pull the regenerated copy/images into the page
      setCandidateRefresh((n) => n + 1);
    },
  });

  const pollStatus = (genPoll?.status ?? "").toLowerCase();
  const pollStage = (genPoll?.stage ?? "").toLowerCase();
  const running = Boolean(genJobId) || starting;
  const optimistic = running && !genPoll;
  const stepStates = regenJobStepStates(
    optimistic ? "queued" : pollStatus,
    optimistic ? "research" : pollStage || "research",
  );
  const jobComplete = !running && (pollStatus === "complete" || pollStage === "complete" || pollStage === "done");
  const jobFailed = !running && pollStatus === "failed";
  const showProgress = running || jobComplete || jobFailed;

  // ── Owner + delete ───────────────────────────────────────────────────────────
  const [ownerDialogOpen, setOwnerDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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
                      <dd className="text-white">{ownerDetails.owner_name?.trim() || "Not set"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Owner email</dt>
                      <dd className="break-all text-white">{ownerDetails.owner_email?.trim() || "Not set"}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="w-28 shrink-0 text-white/60">Shop phone</dt>
                      <dd className="text-white">{ownerDetails.phone?.trim() || "Not set"}</dd>
                    </div>
                  </dl>
                </div>
                <div>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/60">
                    Platform users
                  </h3>
                  {ownerDetails.platform_users.length === 0 ? (
                    <p className="text-white/60">No linked platform users yet.</p>
                  ) : (
                    <ul className="divide-y divide-white/5 rounded-lg border border-white/10">
                      {ownerDetails.platform_users.map((u) => (
                        <li key={u.id} className="px-3 py-2.5">
                          <p className="flex flex-wrap items-baseline justify-between gap-x-3">
                            <span className="text-white">{u.name?.trim() || "No name set"}</span>
                            <span className="text-xs capitalize text-white/70">{u.role}</span>
                          </p>
                          <p className="break-all text-sm text-white/70">{u.email}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            ) : (
              <LoadError what="the owner details" />
            )}
          </DialogContent>
        </Dialog>
      </div>

      {/* ── Owner review: a regenerated live site waits here (migration 049) ──── */}
      <SiteCandidateCard shopId={shop.id} shopSlug={shop.slug} refreshKey={candidateRefresh} />

      {/* ── Configure & regenerate ─────────────────────────────────────────────── */}
      <section className="rounded-xl border border-gold/30 bg-gold/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Configure &amp; regenerate</h2>
        <p className="mt-1 text-sm text-white/60">
          Set the design brief, models, and palette, then regenerate the site. Progress shows below.
        </p>

        {generationPrefs === null ? (
          // The notes are saved back on every run: a blank field here would
          // overwrite the shop's real notes, so the form is not offered at all.
          <LoadError what="this shop's saved generation settings" className="mt-4" />
        ) : (
        <div className="mt-4 space-y-4">
          <Textarea
            label="Design notes"
            value={designNotes}
            onChange={(e) => setDesignNotes(e.target.value)}
            rows={4}
            disabled={running}
            placeholder="Style and content hints for the pipeline…"
          />

          <ModelPicker
            label="Text & research"
            models={textPickerModels}
            value={textModel}
            onChange={setTextModel}
            effort={textEffort}
            onEffortChange={setTextEffort}
            disabled={running}
          />
          <p className="-mt-1 text-xs text-white/60">
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

          <Select label="Site composer" value={composer} onChange={(e) => setComposer(e.target.value)} disabled={running}>
            <option value="ai">AI design director (default)</option>
            <option value="seed">Deterministic seed</option>
          </Select>

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
          <label className="tap-target flex w-fit cursor-pointer select-none items-start gap-2.5 text-sm text-white/80">
            <input
              type="checkbox"
              checked={includeImages}
              disabled={running}
              onChange={(e) => setIncludeImages(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-gold"
            />
            <span>
              Generate new images (hero, logo, service photos)
              <span className="ml-1 text-white/60">(slower, 1 to 3 min). Uncheck to reuse the current images.</span>
            </span>
          </label>

          {reuseBlocked ? (
            <p className="text-sm text-amber-300">
              This shop has no saved hero or logo yet, so images must be generated. Tick the box above, or upload them
              below.
            </p>
          ) : null}

          {genError ? (
            <div role="alert" className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              {genError}
            </div>
          ) : null}

          <div>
            <Button
              type="button"
              className="min-h-12"
              disabled={running || reuseBlocked}
              onClick={() => setConfirmRegenerate(true)}
            >
              {running ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {starting ? "Starting…" : "Generating…"}
                </>
              ) : (
                <>
                  <Sparkles className="h-4 w-4" aria-hidden /> {jobFailed ? "Try again" : "Regenerate site"}
                </>
              )}
            </Button>
            <p className="mt-2 text-xs text-white/60">Uses paid AI calls. You confirm what will run before it starts.</p>
          </div>

          {showProgress ? (
            <div className="rounded-xl border border-white/10 bg-dark-100 p-4">
              {running && followingExisting ? (
                <p role="status" className="mb-3 text-sm text-white/80">
                  A generation was already running for this shop, so this page is following that run. No second run
                  was started.
                </p>
              ) : null}
              <ol className="list-none space-y-2 p-0" aria-label="Generation progress">
                {REGEN_STEP_LABELS.map((label, i) => (
                  <RegenStepRow key={label} label={label} state={stepStates[i]!} index={i} />
                ))}
              </ol>
              {jobComplete ? (
                <p role="status" className="mt-3 text-sm text-emerald-300">
                  {genPoll?.outcome === "candidate"
                    ? "Done. The new version is ready for review at the top of this page. The live site has not changed."
                    : "Done. The site is updated."}
                </p>
              ) : null}
              {jobFailed ? (
                <p role="alert" className="mt-3 text-sm text-red-300">
                  {genPoll?.error ?? "Generation failed."} The site was not changed. You can run it again.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        )}
      </section>

      <ConfirmDialog
        open={confirmRegenerate}
        onCancel={() => setConfirmRegenerate(false)}
        onConfirm={() => {
          setConfirmRegenerate(false);
          void startRegeneration();
        }}
        title={`Regenerate ${shop.name}'s site?`}
        confirmLabel="Regenerate site"
      >
        <p>This starts a new run with paid AI calls:</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Research and all site text with <span className="text-white">{textModelName}</span>
            {sentTextEffort ? ` (reasoning effort: ${sentTextEffort})` : ""}.
          </li>
          <li>
            {includeImages ? (
              <>
                A new hero, logo and every service photo with <span className="text-white">{imageModelName}</span>.
                Images you uploaded or regenerated one by one are kept.
              </>
            ) : (
              "No image calls: the current images are reused."
            )}
          </li>
        </ul>
        <p>
          {sitePublic
            ? "The public site does not change yet. The new version waits at the top of this page for you to preview, then publish or discard."
            : "When the run finishes, the draft site is replaced with the new version. That cannot be undone."}
        </p>
        <p>A run takes a few minutes and cannot be stopped once it starts.</p>
      </ConfirmDialog>

      {/* ── Visuals (logo, hero, per-service photos) ──────────────────────────── */}
      {visuals ? (
        <VisualManager role="developer" shopId={shop.id} apiUrl={apiUrl} {...visuals} />
      ) : (
        <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
          <h2 className="font-heading text-lg font-semibold text-white">Visuals</h2>
          <LoadError what="this shop's images" className="mt-3" />
        </section>
      )}

      {/* ── Danger zone ─────────────────────────────────────────────────────────── */}
      <section className="rounded-xl border border-red-500/30 bg-red-500/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Danger zone</h2>
        <p className="mt-1 text-sm text-white/70">
          Deleting removes the shop, its site, staff accounts, services, bookings and history. This cannot be undone.
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="mt-4"
          onClick={() => setDeleteDialogOpen(true)}
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          Delete shop…
        </Button>
        <DeleteShopDialog
          shop={deleteDialogOpen ? shop : null}
          onClose={() => setDeleteDialogOpen(false)}
          onDeleted={() => {
            forgetJob(shop.id);
            navigate("/dev/shops");
          }}
        />
      </section>

      <nav aria-label="Related pages" className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <Link to="/dev/shops" className="tap-target inline-flex items-center text-gold hover:underline">
          Back to shops list
        </Link>
        <Link to={withShopId("/admin", shop.id)} className="tap-target inline-flex items-center text-gold hover:underline">
          Manage as admin
        </Link>
        {siteStatus === "live" ? (
          <a
            href={`${publicOrigin}/${shop.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="tap-target inline-flex items-center gap-1 text-gold hover:underline"
          >
            View live site <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        ) : (
          <span className="inline-flex items-center text-white/60">
            {siteStatus === "paused"
              ? "Site is paused (not public)"
              : siteStatus === "draft"
                ? "Site is a draft (not public)"
                : "No site yet"}
          </span>
        )}
      </nav>
    </div>
  );
}
