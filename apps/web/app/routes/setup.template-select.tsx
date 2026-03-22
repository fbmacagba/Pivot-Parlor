import { useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

const TEMPLATES = [
  {
    id: "minimal",
    name: "Minimal",
    tagline: "Clean & Modern — White space, serif headings",
    primaryColor: "#374151",
  },
  {
    id: "luxury",
    name: "Luxury",
    tagline: "Dark Luxury — Black and gold, premium feel",
    primaryColor: "#C9A84C",
  },
  {
    id: "vibrant",
    name: "Vibrant",
    tagline: "Bold & Vibrant — Strong colours, energetic layout",
    primaryColor: "#E07C5C",
  },
  {
    id: "editorial",
    name: "Editorial",
    tagline: "Warm Editorial — Soft tones, lifestyle feel",
    primaryColor: "#c4a77d",
  },
  {
    id: "classic",
    name: "Classic",
    tagline: "Classic Barber — Deep red, vintage typography",
    primaryColor: "#8B0000",
  },
  {
    id: "fresh",
    name: "Fresh",
    tagline: "Fresh & Bright — Pastel tones, rounded and friendly",
    primaryColor: "#81c784",
  },
] as const;

export async function loader({ request, context }: LoaderFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  const user = await api.get<{ id: string; role: string; shop_id: string | null }>("/auth/me");
  if (!user.shop_id) throw redirect("/admin");

  const shop = await api.get<{ id: string; name: string; slug: string }>(
    `/api/shops/${user.shop_id}`
  );

  try {
    await api.get(`/api/shops/${shop.slug}/site`);
    throw redirect("/admin");
  } catch {
    // No site — continue to template select
  }

  return json({ shop });
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  const api = createApiClient(env.API_URL, token);

  const user = await api.get<{ id: string; role: string; shop_id: string | null }>("/auth/me");
  if (!user.shop_id) return json({ error: "Unauthorized", jobId: null }, 401);

  const formData = await request.formData();
  const template = formData.get("template")?.toString();
  const colorPrimary = formData.get("color_primary")?.toString();
  const colorAccent = formData.get("color_accent")?.toString();
  const designNotes = formData.get("design_notes")?.toString();
  const logoFile = formData.get("logo_file") as File | null;

  if (!template) return json({ error: "Please select a template", jobId: null }, 400);

  const jsonBody: Record<string, unknown> = {
    template,
    color_primary: colorPrimary || undefined,
    color_accent: colorAccent || undefined,
    design_notes: designNotes || undefined,
  };

  if (logoFile && logoFile.size > 0) {
    const fd = new FormData();
    fd.append("template", template);
    if (colorPrimary) fd.append("color_primary", colorPrimary);
    if (colorAccent) fd.append("color_accent", colorAccent);
    if (designNotes) fd.append("design_notes", designNotes);
    fd.append("logo_file", logoFile);

    const res = await fetch(`${env.API_URL}/api/shops/${user.shop_id}/generate-site`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    const data = (await res.json()) as {
      success?: boolean;
      data?: { jobId: string; message?: string };
      error?: string;
    };
    if (!res.ok) return json({ error: data.error ?? "Generation failed", jobId: null }, 400);
    if (!data.success || !data.data?.jobId) {
      return json({ error: data.error ?? "Invalid response", jobId: null }, 400);
    }
    return json({ error: null, jobId: data.data.jobId, message: data.data.message ?? null });
  }

  try {
    const out = await api.post<{ jobId: string; message: string }>(
      `/api/shops/${user.shop_id}/generate-site`,
      jsonBody
    );
    return json({ error: null, jobId: out.jobId, message: out.message ?? null });
  } catch (err) {
    return json(
      { error: err instanceof Error ? err.message : "Generation failed", jobId: null },
      400
    );
  }
}

type JobStatusPayload = {
  success?: boolean;
  data?: { status?: string; stage?: string; shopSlug?: string; error?: string };
  error?: string;
};

function progressCopy(stage: string | undefined, status: string | undefined): string {
  if (status === "failed") return "";
  if (stage === "done" || status === "complete") {
    return "Your site is ready! Redirecting...";
  }
  switch (stage) {
    case "queued":
      return "Queuing your site generation...";
    case "research":
      return "Researching your brand and market positioning...";
    case "build":
      return "Building your website and generating images...";
    case "audit":
      return "Running quality checks on your site...";
    default:
      return "Working on your site...";
  }
}

export default function TemplateSelect() {
  const { shop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [colorPrimary, setColorPrimary] = useState("#8B0000");
  const [colorAccent, setColorAccent] = useState("#1a1f3a");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStage, setJobStage] = useState<string>("");
  const [jobStatus, setJobStatus] = useState<string>("");
  const [jobError, setJobError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSubmitting = fetcher.state !== "idle";
  const isPolling = !!jobId;
  const showProgress = isPolling || redirecting;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("jobId" in fetcher.data && fetcher.data.jobId && !fetcher.data.error) {
      setJobId(fetcher.data.jobId);
      setJobError(null);
      setJobStage("queued");
      setJobStatus("queued");
    }
    if (fetcher.data.error) {
      setJobId(null);
    }
  }, [fetcher.state, fetcher.data]);

  useEffect(() => {
    if (!jobId) return;

    let cancelled = false;
    const poll = async () => {
      try {
        const r = await fetch(`/api/jobs/${jobId}/status`);
        const j = (await r.json()) as JobStatusPayload;
        if (cancelled) return;
        if (!j.success || !j.data) {
          setJobError(j.error ?? "Status request failed");
          setJobId(null);
          return;
        }
        const { stage, status, error } = j.data;
        setJobStage(stage ?? "");
        setJobStatus(status ?? "");
        if (status === "failed" || stage === "failed") {
          setJobError(error ?? "Generation failed");
          setJobId(null);
          return;
        }
        if (stage === "done" || status === "complete") {
          setJobStage("done");
          setJobStatus(status ?? "complete");
          setRedirecting(true);
          setJobId(null);
          if (redirectTimer.current) clearTimeout(redirectTimer.current);
          redirectTimer.current = setTimeout(() => {
            navigate("/admin?siteGenerated=1");
          }, 2000);
        }
      } catch {
        if (!cancelled) setJobError("Could not load job status");
      }
    };

    void poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, [jobId, navigate]);

  const tryAgain = useCallback(() => {
    setJobId(null);
    setJobError(null);
    setJobStage("");
    setJobStatus("");
    setRedirecting(false);
    if (redirectTimer.current) clearTimeout(redirectTimer.current);
    setSelectedTemplate(null);
    setFormKey((k) => k + 1);
  }, []);

  return (
    <div className="min-h-screen bg-[#0D0D0D] px-6 py-12">
      <div className="mx-auto max-w-6xl">
        <h1 className="font-heading text-2xl font-bold text-white" data-shop-slug={shop.slug}>
          Choose your template for {shop.name}
        </h1>
        <p className="mt-2 text-white/60">Select a design, customise colours, then generate.</p>

        {showProgress && (
          <div className="mt-8 rounded-xl border border-[#C9A84C]/40 bg-[#C9A84C]/10 px-6 py-5">
            <p className="text-sm font-medium text-[#C9A84C]">
              {progressCopy(jobStage, jobStatus)}
            </p>
            <p className="mt-1 text-xs text-white/50">
              Stage: {jobStage || "…"} · Status: {jobStatus || "…"}
            </p>
          </div>
        )}

        {jobError && (
          <div className="mt-8 space-y-3 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <p>Generation failed: {jobError}. Please try again.</p>
            <button
              type="button"
              onClick={tryAgain}
              className="rounded-lg border border-white/30 px-4 py-2 text-white hover:bg-white/10"
            >
              Try Again
            </button>
          </div>
        )}

        <form
          key={formKey}
          method="post"
          className="mt-10 space-y-10"
          onSubmit={(e) => {
            e.preventDefault();
            fetcher.submit(new FormData(e.currentTarget), { method: "post" });
          }}
        >
          {/* Template grid */}
          <div>
            <h2 className="mb-4 text-lg font-semibold text-white">Template</h2>
            <input type="hidden" name="template" value={selectedTemplate ?? ""} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {TEMPLATES.map((t) => (
                <TemplateCard
                  key={t.id}
                  id={t.id}
                  name={t.name}
                  tagline={t.tagline}
                  primaryColor={t.primaryColor}
                  selected={selectedTemplate === t.id}
                  onSelect={() => setSelectedTemplate(t.id)}
                />
              ))}
            </div>
          </div>

          {/* Owner customisation panel */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">Owner customisation</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm text-white/80">Primary colour</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="color"
                    name="color_primary"
                    value={colorPrimary}
                    onChange={(e) => setColorPrimary(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                  <span className="font-mono text-sm text-white">{colorPrimary}</span>
                </div>
              </div>
              <div>
                <label className="block text-sm text-white/80">Accent colour</label>
                <div className="mt-1 flex items-center gap-2">
                  <input
                    type="color"
                    name="color_accent"
                    value={colorAccent}
                    onChange={(e) => setColorAccent(e.target.value)}
                    className="h-10 w-14 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                  <span className="font-mono text-sm text-white">{colorAccent}</span>
                </div>
              </div>
            </div>
            <div className="mt-4">
              <label className="block text-sm text-white/80">Design notes</label>
              <textarea
                name="design_notes"
                rows={3}
                placeholder="Describe your style, e.g. modern and minimal, we specialise in afro hair"
                className="mt-1 w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder-white/40"
              />
            </div>
            <div className="mt-4">
              <label className="block text-sm text-white/80">
                Upload your logo (optional — skips AI logo generation)
              </label>
              <input
                type="file"
                name="logo_file"
                accept=".png,.jpg,.svg"
                className="mt-1 block w-full text-sm text-white/80 file:mr-4 file:rounded file:border-0 file:bg-[#C9A84C] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-black"
              />
            </div>
          </div>

          {fetcher.data && "error" in fetcher.data && fetcher.data.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {fetcher.data.error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !selectedTemplate || isPolling || redirecting || !!jobError}
            className="w-full rounded-lg bg-[#C9A84C] py-4 text-sm font-semibold text-black transition hover:bg-[#D4B86A] disabled:opacity-50"
          >
            {isSubmitting
              ? "Starting generation..."
              : isPolling || redirecting
                ? "Generation in progress..."
                : "Generate My Site →"}
          </button>
        </form>
      </div>
    </div>
  );
}

function TemplateCard({
  name,
  tagline,
  primaryColor,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  tagline: string;
  primaryColor: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`relative flex flex-col rounded-xl border-2 p-4 transition ${
        selected ? "" : "border-white/20 hover:border-white/40"
      }`}
      style={
        selected
          ? { borderColor: primaryColor, borderWidth: 4 }
          : {
              borderLeftWidth: 4,
              borderLeftColor: primaryColor,
            }
      }
    >
      {selected && (
        <div
          className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded-full"
          style={{ backgroundColor: primaryColor }}
        >
          <span className="text-xs font-bold text-white">✓</span>
        </div>
      )}
      <div
        className="mb-3 h-1 w-full rounded-full"
        style={{ backgroundColor: primaryColor }}
      />
      <span className="font-medium text-white">{name}</span>
      <span className="mt-1 text-sm text-white/60">{tagline}</span>
      <button
        type="button"
        onClick={onSelect}
        className="mt-3 rounded-lg border border-white/30 px-4 py-2 text-sm text-white hover:bg-white/10"
      >
        Select
      </button>
    </div>
  );
}
