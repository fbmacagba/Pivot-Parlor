import { useFetcher, useLoaderData } from "@remix-run/react";
import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { createApiClient } from "~/lib/api";

const TEMPLATES = [
  { id: "minimal", name: "Minimal", tagline: "Clean and spacious" },
  { id: "luxury", name: "Luxury", tagline: "Dark and premium" },
  { id: "vibrant", name: "Vibrant", tagline: "Bold and energetic" },
  { id: "editorial", name: "Editorial", tagline: "Magazine-style layout" },
  { id: "classic", name: "Classic", tagline: "Traditional barbershop feel" },
  { id: "fresh", name: "Fresh", tagline: "Bright and airy" },
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
  if (!user.shop_id) return json({ error: "Unauthorized" }, 401);

  const formData = await request.formData();
  const template = formData.get("template")?.toString();
  const colorPrimary = formData.get("color_primary")?.toString();
  const colorAccent = formData.get("color_accent")?.toString();
  const designNotes = formData.get("design_notes")?.toString();
  const logoFile = formData.get("logo_file") as File | null;

  if (!template) return json({ error: "Please select a template" }, 400);

  const body: Record<string, unknown> = {
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

    const data = (await res.json()) as { success?: boolean; error?: string };
    if (!res.ok) return json({ error: data.error ?? "Generation failed" }, 400);
    throw redirect("/admin?site_live=1");
  }

  try {
    await api.post(`/api/shops/${user.shop_id}/generate-site`, body);
    throw redirect("/admin?site_live=1");
  } catch (err) {
    if (err instanceof Response) throw err;
    return json({ error: err instanceof Error ? err.message : "Generation failed" }, 400);
  }
}

export default function TemplateSelect() {
  const { shop } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [colorPrimary, setColorPrimary] = useState("#8B0000");
  const [colorAccent, setColorAccent] = useState("#1a1f3a");
  const isSubmitting = fetcher.state !== "idle";

  return (
    <div className="min-h-screen bg-[#0D0D0D] px-6 py-12">
      <div className="mx-auto max-w-6xl">
        <h1 className="font-heading text-2xl font-bold text-white" data-shop-slug={shop.slug}>
          Choose your template for {shop.name}
        </h1>
        <p className="mt-2 text-white/60">Select a design, customise colours, then generate.</p>

        <fetcher.Form method="post" className="mt-10 space-y-10">
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
                  selected={selectedTemplate === t.id}
                  onSelect={() => setSelectedTemplate(t.id)}
                />
              ))}
            </div>
          </div>

          {/* Customisation */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h2 className="mb-4 text-lg font-semibold text-white">Customisation</h2>
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
              <label className="block text-sm text-white/80">Logo upload (optional)</label>
              <input
                type="file"
                name="logo_file"
                accept=".png,.jpg,.jpeg,.svg"
                className="mt-1 block w-full text-sm text-white/80 file:mr-4 file:rounded file:border-0 file:bg-[#C9A84C] file:px-4 file:py-2 file:text-sm file:font-semibold file:text-black"
              />
            </div>
          </div>

          {fetcher.data?.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {fetcher.data.error}
            </div>
          )}

          <button
            type="submit"
            disabled={isSubmitting || !selectedTemplate}
            className="w-full rounded-lg bg-[#C9A84C] py-4 text-sm font-semibold text-black transition hover:bg-[#D4B86A] disabled:opacity-50"
          >
            {isSubmitting
              ? "Generating your site — this takes about 15 seconds"
              : "Generate My Site"}
          </button>
        </fetcher.Form>
      </div>
    </div>
  );
}

function TemplateCard({
  id,
  name,
  tagline,
  selected,
  onSelect,
}: {
  id: string;
  name: string;
  tagline: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div
      className={`flex flex-col rounded-xl border-2 p-4 transition ${
        selected ? "border-[#C9A84C]" : "border-white/20 hover:border-white/40"
      }`}
    >
      <div className="mb-3 h-24 rounded-lg bg-white/10" />
      <span className="font-medium text-white">{name}</span>
      <span className="text-sm text-white/60">{tagline}</span>
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
