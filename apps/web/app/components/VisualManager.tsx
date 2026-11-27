import { useRef, useState } from "react";
import { useRevalidator } from "react-router";
import { Check, Loader2, Sparkles, Trash2, Upload } from "lucide-react";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { ConfirmDialog } from "~/components/ui/ConfirmDialog";
import { resolvePublicAssetImageUrl, withImageCacheBust } from "~/components/dev-shops/helpers";

export interface VisualsData {
  hero: { url: string | null; locked: boolean };
  logo: { url: string | null; locked: boolean };
  catalog: string[];
  services: { id: string; name: string; image_url: string | null }[];
}

export interface VisualManagerProps extends VisualsData {
  shopId: string;
  apiUrl: string;
  role: "developer" | "admin";
}

/**
 * Upload flow, extracted so it is unit-testable without DOM interaction:
 * POST upload-image (multipart) then POST save-image (json) with the SAME type.
 * `doFetch` is injectable for tests; defaults to the global fetch.
 */
export async function uploadVisual(
  shopId: string,
  type: string,
  file: File,
  doFetch: typeof fetch = fetch,
): Promise<{ ok: boolean; error?: string }> {
  const fd = new FormData();
  fd.set("type", type);
  fd.set("file", file);
  const upRes = await doFetch(`/api/shops/${shopId}/upload-image`, { method: "POST", body: fd });
  const upJson = (await upRes.json().catch(() => ({}))) as { imageUrl?: string; error?: string };
  const url = typeof upJson.imageUrl === "string" ? upJson.imageUrl.trim() : "";
  if (!upRes.ok || !url) return { ok: false, error: upJson.error?.trim() || "Upload failed." };
  const svRes = await doFetch(`/api/shops/${shopId}/save-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, imageUrl: url }),
  });
  const svJson = (await svRes.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!svRes.ok || svJson.ok === false) {
    return { ok: false, error: svJson.error?.trim() || "Could not save the image." };
  }
  return { ok: true };
}

interface Tile {
  /** Wire type sent to the endpoints: "hero" | "logo" | `service:<id>`. */
  type: string;
  label: string;
  /** Current image to preview (custom, else catalog fallback), or null. */
  url: string | null;
  /** Custom => shows the badge; a service is custom when it has its own image. */
  locked: boolean;
}

export function VisualManager({ shopId, apiUrl, role, hero, logo, catalog, services }: VisualManagerProps) {
  const revalidator = useRevalidator();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bust, setBust] = useState(0);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const tiles: Tile[] = [
    { type: "hero", label: "Hero", url: hero.url, locked: hero.locked },
    { type: "logo", label: "Logo", url: logo.url, locked: logo.locked },
    ...services.map((s, i) => ({
      type: `service:${s.id}`,
      label: s.name,
      url: s.image_url || catalog[i] || null,
      locked: s.image_url != null,
    })),
  ];

  async function post(path: string, body: unknown): Promise<{ ok: boolean; json: Record<string, unknown> }> {
    const res = await fetch(`/api/shops/${shopId}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && json.ok !== false && !json.error, json };
  }

  async function handleUpload(type: string, file: File) {
    if (busy) return;
    setError(null);
    setBusy(type);
    try {
      const result = await uploadVisual(shopId, type, file);
      if (!result.ok) {
        setError(result.error ?? "Upload failed.");
        return;
      }
      setBust(Date.now());
      revalidator.revalidate();
    } catch {
      setError("Could not upload the image. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  /** Runs the confirmed action. True when it worked, so the dialog can close. */
  async function handleRegenerate(type: string): Promise<boolean> {
    if (busy) return false;
    setError(null);
    setBusy(type);
    try {
      const res = await fetch(`/api/shops/${shopId}/generate-image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type }),
      });
      const json = (await res.json().catch(() => ({}))) as { imageUrl?: string; error?: string };
      if (!res.ok || !json.imageUrl) {
        setError(json.error?.trim() || "Could not regenerate the image. The current one is unchanged.");
        return false;
      }
      setBust(Date.now());
      revalidator.revalidate();
      return true;
    } catch {
      setError("Could not regenerate the image. The current one is unchanged. Please try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove(type: string): Promise<boolean> {
    if (busy) return false;
    setError(null);
    setBusy(type);
    try {
      const removed = await post("remove-image", { type });
      if (!removed.ok) {
        setError((removed.json.error as string)?.trim() || "Could not remove the image. It is still in place.");
        return false;
      }
      setBust(Date.now());
      revalidator.revalidate();
      return true;
    } catch {
      setError("Could not remove the image. It is still in place. Please try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  // Regenerate costs a paid image call and Remove deletes an image: both are
  // confirmed first. One action runs at a time, so every tile's buttons lock
  // (visibly) while one is busy.
  const [confirm, setConfirm] = useState<{ kind: "regenerate" | "remove"; tile: Tile } | null>(null);
  const anyBusy = busy !== null;

  async function runConfirmed() {
    if (!confirm) return;
    const ok =
      confirm.kind === "regenerate" ? await handleRegenerate(confirm.tile.type) : await handleRemove(confirm.tile.type);
    if (ok) setConfirm(null);
  }

  return (
    <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
      <h2 className="font-heading text-lg font-semibold text-white">Visuals</h2>
      <p className="mt-1 text-sm text-white/60">
        {role === "developer"
          ? "Upload, regenerate or remove any single image. Uploaded and regenerated images are kept when the site is regenerated."
          : "Upload your own image for any visual. Uploaded images are kept when the site is regenerated."}
      </p>
      {error && !confirm ? (
        <div role="alert" className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-200">
          {error}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        onCancel={() => {
          setConfirm(null);
          setError(null);
        }}
        onConfirm={() => void runConfirmed()}
        title={
          confirm?.kind === "remove"
            ? `Remove the ${confirm.tile.label} image?`
            : `Regenerate the ${confirm?.tile.label ?? ""} image?`
        }
        confirmLabel={confirm?.kind === "remove" ? "Remove image" : "Regenerate image"}
        pendingLabel={confirm?.kind === "remove" ? "Removing…" : "Generating…"}
        destructive={confirm?.kind === "remove"}
        pending={anyBusy}
        error={confirm ? error : null}
      >
        {confirm?.kind === "remove" ? (
          <p>
            This clears the {confirm.tile.locked ? "custom " : ""}image from the site.{" "}
            {confirm.tile.type.startsWith("service:")
              ? "The service goes back to its catalogue photo."
              : "The site shows none until you upload or generate another."}{" "}
            The removed image cannot be brought back.
          </p>
        ) : (
          <p>
            This makes one paid AI image call and replaces the current image when it finishes. The current image
            cannot be brought back.
          </p>
        )}
      </ConfirmDialog>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {tiles.map((tile) => {
          const src = tile.url
            ? withImageCacheBust(resolvePublicAssetImageUrl(tile.url, apiUrl), bust)
            : "";
          const tileBusy = busy === tile.type;
          return (
            <div
              key={tile.type}
              data-testid={`visual-tile-${tile.type}`}
              className="rounded-lg border border-white/10 bg-white/[0.03] p-3"
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="truncate text-sm font-medium text-white/80">{tile.label}</span>
                {tile.locked ? (
                  <Badge variant="gold">
                    <Check className="h-3 w-3" aria-hidden /> Custom
                  </Badge>
                ) : null}
              </div>
              <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/30">
                {src ? (
                  <img src={src} alt={`${tile.label} preview`} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs text-white/60">No image</span>
                )}
              </div>
              <input
                ref={(el) => {
                  fileInputs.current[tile.type] = el;
                }}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) void handleUpload(tile.type, f);
                }}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={anyBusy}
                  onClick={() => fileInputs.current[tile.type]?.click()}
                >
                  {tileBusy ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  ) : (
                    <Upload className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {tileBusy ? "Working…" : "Upload"}
                  <span className="sr-only"> {tile.label} image</span>
                </Button>
                {role === "developer" ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={anyBusy}
                      onClick={() => {
                        setError(null);
                        setConfirm({ kind: "regenerate", tile });
                      }}
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden /> Regenerate
                      <span className="sr-only"> {tile.label} image</span>
                    </Button>
                    {/* Only where there is an image of its own to clear: a service
                        showing its catalogue photo has nothing to remove. */}
                    {(tile.type.startsWith("service:") ? tile.locked : Boolean(tile.url)) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={anyBusy}
                        onClick={() => {
                          setError(null);
                          setConfirm({ kind: "remove", tile });
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden /> Remove
                        <span className="sr-only"> {tile.label} image</span>
                      </Button>
                    ) : null}
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
