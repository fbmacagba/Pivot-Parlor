import {
  Form,
  Link,
  useActionData,
  useNavigation,
  useOutletContext,
} from "@remix-run/react";
import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { Loader2, Sparkles } from "lucide-react";
import { getSessionToken } from "~/lib/auth";
import { apiE2eHeadersFromCookieHeader } from "~/lib/e2e-api-headers";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import type { DevGenerationPrefs, DevShopDetail } from "./dev.shops.$shopId";

export async function action({ request, params, context }: ActionFunctionArgs) {
  const shopId = params.shopId!;
  const form = await request.formData();
  if (form.get("_action") !== "regenerate-site") {
    return json({ ok: false, error: "Unknown action" }, 400);
  }

  const env = context.env as { API_URL: string };
  const token = getSessionToken(request);
  if (!token) return json({ ok: false, error: "Unauthorized" }, 401);
  const api = createApiClient(env.API_URL, token, apiE2eHeadersFromCookieHeader(request.headers.get("Cookie")));

  let prefs: DevGenerationPrefs;
  try {
    prefs = await api.get<DevGenerationPrefs>(`/api/shops/${shopId}/generation-prefs`);
  } catch {
    prefs = {
      template: "minimal",
      design_notes: null,
      color_primary: null,
      color_accent: null,
    };
  }

  const body: Record<string, unknown> = {
    template: prefs.template?.trim() || "minimal",
  };
  if (prefs.design_notes?.trim()) body.design_notes = prefs.design_notes.trim();
  if (prefs.color_primary?.trim()) body.color_primary = prefs.color_primary.trim();
  if (prefs.color_accent?.trim()) body.color_accent = prefs.color_accent.trim();

  try {
    const result = await api.post<{ jobId: string }>(`/api/shops/${shopId}/generate-site`, body);
    return redirect(`/dev/shops/${shopId}/generation/${result.jobId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Site generation failed";
    return json({ ok: false, error: msg }, 400);
  }
}

export default function DevShopDetailIndex() {
  const { shop, generationPrefs } = useOutletContext<{ shop: DevShopDetail; generationPrefs: DevGenerationPrefs }>();
  const navigation = useNavigation();
  const actionData = useActionData<{ ok?: boolean; error?: string }>();
  const busy =
    navigation.state !== "idle" &&
    navigation.formData?.get("_action") === "regenerate-site";

  return (
    <div className="max-w-2xl space-y-8">
      {actionData?.error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {actionData.error}
        </div>
      )}
      <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Saved generation inputs</h2>
        <p className="mt-1 text-sm text-white/50">
          Regenerate uses these values from the active <code className="text-white/70">shop_sites</code> row (owner
          colours and design notes when set).
        </p>
        <dl className="mt-4 space-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/40">Template</dt>
            <dd className="text-white">{generationPrefs.template}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/40">Primary</dt>
            <dd className="text-white">{generationPrefs.color_primary ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/40">Accent</dt>
            <dd className="text-white">{generationPrefs.color_accent ?? "—"}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-36 shrink-0 text-white/40 align-top">Design notes</dt>
            <dd className="whitespace-pre-wrap text-white/80">
              {generationPrefs.design_notes?.trim() ? generationPrefs.design_notes : "—"}
            </dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-gold/30 bg-gold/5 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Regenerate site</h2>
        <p className="mt-1 text-sm text-white/50">
          Queues a new full site generation run with the saved inputs above (same as{" "}
          <code className="text-white/70">POST /api/shops/:shopId/generate-site</code>).
        </p>
        <Form method="post" className="mt-4">
          <input type="hidden" name="_action" value="regenerate-site" />
          <Button type="submit" disabled={busy} className="min-h-12">
            {busy ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                Regenerate site
              </>
            )}
          </Button>
        </Form>
      </section>

      <p className="text-sm text-white/40">
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
