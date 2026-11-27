// One shop on the developer "Shops" list: a card on a phone, a grid row from
// `lg`. The route owns every fetcher and dialog; this only draws the row and
// reports what was pressed.
import { Link } from "react-router";
import { Bot, Copy, ExternalLink, Loader2, Sparkles, Trash2 } from "lucide-react";
import { formatPence } from "@repo/utils";
import { Badge } from "~/components/ui/Badge";
import { Button } from "~/components/ui/Button";
import { Select } from "~/components/ui/Select";
import { StatusBadge as SharedStatusBadge } from "~/components/ui/StatusBadge";
import { modelBadgeVariant, shopStage } from "./helpers";
import { SiteStatusBadge, StatusBadge } from "./StatusBadge";
import type { Shop } from "./types";

export type SiteIntent = "activate" | "pause" | "resume";

/** The grid shared by the header strip and every row, so columns line up. */
export const SHOP_ROW_GRID =
  "lg:grid lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1.2fr)_minmax(0,1.5fr)_minmax(0,2.4fr)] lg:gap-4";

const PENDING_LABEL: Record<SiteIntent, string> = {
  activate: "Activating…",
  pause: "Pausing…",
  resume: "Resuming…",
};

export function ShopRow({
  shop,
  publicOrigin,
  generating,
  generateLocked,
  generationFailure,
  pendingSiteIntent,
  paymentCopied,
  onCopyPaymentLink,
  onSiteIntent,
  onGenerate,
  onRates,
  onDelete,
}: {
  shop: Shop;
  /** The public site's origin, e.g. https://pivotparlor.com. */
  publicOrigin: string;
  /** A generation for this shop is starting or being followed. */
  generating: boolean;
  /** Another shop's generation is being started; one start at a time. */
  generateLocked: boolean;
  /** Why this shop's last generation here did not finish, if it did not. */
  generationFailure: string | null;
  /** The site change in flight for this shop, if any. */
  pendingSiteIntent: SiteIntent | null;
  paymentCopied: boolean;
  onCopyPaymentLink: (url: string) => void;
  onSiteIntent: (intent: SiteIntent) => void;
  onGenerate: (choice: { template: string; composer: string }) => void;
  onRates: () => void;
  onDelete: () => void;
}) {
  const stage = shopStage(shop);
  const isActiveShop = shop.status === "active";
  const siteHref = `${publicOrigin}/${shop.slug}`;
  const bookings = shop.booking_count ?? 0;
  const siteBusy = pendingSiteIntent !== null;

  return (
    <li
      data-testid="shop-row"
      className={`rounded-xl border border-white/10 bg-dark-100 p-4 lg:rounded-none lg:border-0 lg:bg-transparent lg:px-5 lg:py-4 lg:hover:bg-white/[0.02] ${SHOP_ROW_GRID}`}
    >
      {/* Who */}
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-medium text-white">{shop.name}</span>
          <span className="text-xs text-white/60">#{shop.shop_number}</span>
        </p>
        <p className="break-all text-xs text-white/60">/{shop.slug}</p>
        <p className="mt-1 break-all text-sm text-white/70">{shop.owner_email || "No owner email"}</p>
      </div>

      {/* What */}
      <div className="mt-3 min-w-0 space-y-1.5 lg:mt-0">
        <p className="text-sm capitalize text-white/70">{shop.type.replace(/_/g, " ")}</p>
        {shop.ai_model ? (
          <Badge variant={modelBadgeVariant(shop.ai_model)} className="max-w-full">
            <span className="truncate">{shop.ai_model.replace(/-/g, " ")}</span>
          </Badge>
        ) : (
          <p className="text-xs text-white/60">No AI model set</p>
        )}
      </div>

      {/* State and numbers */}
      <div className="mt-3 min-w-0 space-y-1.5 lg:mt-0">
        <div className="flex flex-wrap gap-1.5">
          <StatusBadge shop={shop} />
          {isActiveShop && <SiteStatusBadge shop={shop} />}
          {/* "Site in progress", not "Generating": the row's button already says that. */}
          {generating && <SharedStatusBadge status="in_progress" label="Site in progress" />}
          {!generating && generationFailure && <SharedStatusBadge status="failed" label="Generation failed" />}
        </div>
        <p className="text-sm text-white/70">
          {bookings} {bookings === 1 ? "booking" : "bookings"}
          <span aria-hidden> · </span>
          <span className="text-white">{formatPence(shop.commission_total_pence ?? 0)}</span> commission
        </p>
      </div>

      {/* Actions */}
      <div className="mt-4 min-w-0 space-y-3 lg:mt-0">
        <div className="flex flex-wrap items-center gap-2">
          {shop.stripe_payment_status === "unpaid" && shop.stripe_checkout_url && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => onCopyPaymentLink(shop.stripe_checkout_url!)}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden /> {paymentCopied ? "Copied!" : "Copy Payment Link"}
            </Button>
          )}
          {isActiveShop && (
            <Button asChild variant="secondary" size="sm">
              <Link to={`/dev/shops/${shop.id}`}>Manage</Link>
            </Button>
          )}
          {stage === "draft" && (
            <Button type="button" variant="outline" size="sm" disabled={siteBusy} onClick={() => onSiteIntent("activate")}>
              {pendingSiteIntent === "activate" ? PENDING_LABEL.activate : "Activate Website"}
            </Button>
          )}
          {stage === "live" && (
            <Button type="button" variant="secondary" size="sm" disabled={siteBusy} onClick={() => onSiteIntent("pause")}>
              {pendingSiteIntent === "pause" ? PENDING_LABEL.pause : "Pause"}
            </Button>
          )}
          {stage === "paused" && (
            <Button type="button" variant="outline" size="sm" disabled={siteBusy} onClick={() => onSiteIntent("resume")}>
              {pendingSiteIntent === "resume" ? PENDING_LABEL.resume : "Resume"}
            </Button>
          )}

          <details className="group min-w-0">
            <summary className="tap-target inline-flex h-8 cursor-pointer list-none items-center rounded-lg border border-white/10 bg-dark-200 px-3 text-xs font-medium text-white hover:bg-dark-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold [&::-webkit-details-marker]:hidden">
              More<span className="sr-only"> actions for {shop.name}</span>
            </summary>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={onRates}>
                Rates<span className="sr-only">: commission on services and retail</span>
              </Button>
              {stage === "draft" && (
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/dev/shops/${shop.id}/preview`}>Site summary</Link>
                </Button>
              )}
              {(stage === "live" || stage === "paused") && (
                <Button asChild variant="ghost" size="sm">
                  <a href={siteHref} target="_blank" rel="noopener noreferrer">
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden /> View Website
                    <span className="sr-only">(opens in a new tab)</span>
                  </a>
                </Button>
              )}
              <Button asChild variant="ghost" size="sm">
                <Link to={`/dev/ai-deploy?shopId=${shop.id}`}>
                  <Bot className="h-3.5 w-3.5" aria-hidden /> AI Deploy
                </Link>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                onClick={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
                Delete
              </Button>
            </div>
          </details>
        </div>

        {stage === "no_site" && (
          <form
            className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              onGenerate({
                template: String(form.get("template") ?? ""),
                composer: String(form.get("composer") ?? "ai"),
              });
            }}
          >
            <Select label="Template" name="template" defaultValue="" disabled={generating}>
              <option value="">Auto</option>
              <option value="minimal">Minimal</option>
              <option value="luxury">Luxury</option>
              <option value="vibrant">Vibrant</option>
              <option value="editorial">Editorial</option>
              <option value="classic">Classic</option>
              <option value="fresh">Fresh</option>
            </Select>
            <Select label="Composer" name="composer" defaultValue="ai" disabled={generating}>
              <option value="ai">AI design director</option>
              <option value="seed">Deterministic seed</option>
            </Select>
            <Button
              type="submit"
              variant="outline"
              className="col-span-2 sm:col-span-1"
              disabled={generating || generateLocked}
            >
              {generating ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Generating…
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" aria-hidden /> {generationFailure ? "Try again" : "Generate Site"}
                </>
              )}
            </Button>
            <p className="col-span-full text-xs text-white/60">
              {generateLocked && !generating
                ? "Another site is being generated. One run at a time from this list."
                : "Runs research, text and image generation with paid AI calls. Takes a few minutes."}
            </p>
          </form>
        )}

        {!generating && generationFailure && (
          <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            Site generation did not finish: {generationFailure}
            {stage === "no_site" ? " Use Try again to start a new run." : " Open Manage to run it again."}
          </p>
        )}
      </div>
    </li>
  );
}
