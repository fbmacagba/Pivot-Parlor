// New-shop onboarding dialog for the developer "Shops" dashboard.
// Presentational: all state stays in the route and is passed in. Covered by
// shop-onboarding.spec.ts + dev-dashboard.spec.ts (create + invite link + copy).
import type { FetcherWithComponents } from "react-router";
import type { ChangeEvent, RefObject } from "react";
import { Copy, ExternalLink, Plus } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { Select } from "~/components/ui/Select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/Dialog";
import type { DevShopsActionJson } from "./types";

export function OnboardShopDialog({
  open,
  onOpenChange,
  fetcher,
  errorMessage,
  submitting,
  checkoutUrl,
  inviteUrl,
  copied,
  onCopyInvite,
  onCopyPayment,
  slug,
  onSlugChange,
  onNameChange,
  nameRef,
  publicHost,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fetcher: FetcherWithComponents<DevShopsActionJson>;
  errorMessage: string | null;
  submitting: boolean;
  checkoutUrl: string | null;
  inviteUrl: string | null;
  copied: boolean;
  onCopyInvite: () => void;
  onCopyPayment: (url: string) => void;
  slug: string;
  onSlugChange: (value: string) => void;
  onNameChange: (e: ChangeEvent<HTMLInputElement>) => void;
  nameRef: RefObject<HTMLInputElement | null>;
  /** The public site's host, for the "Final URL" hint. */
  publicHost: string;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4" aria-hidden /> New Shop
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Onboard new shop</DialogTitle>
        </DialogHeader>

        {/* Success state: the payment link, or the invite link */}
        {checkoutUrl ? (
          <div className="space-y-4">
            <div
              role="status"
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300"
            >
              Shop created! Send the £100 payment link to the owner. Once paid, the invite link will activate.
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/60">Payment link (£100)</p>
              <p className="break-all font-mono text-sm text-white">{checkoutUrl}</p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={() => onCopyPayment(checkoutUrl)}
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
                {copied ? "Copied!" : "Copy Payment Link"}
              </Button>
              <Button asChild variant="ghost" size="sm" className="flex-1">
                <a href={checkoutUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </Button>
            </div>
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : inviteUrl ? (
          <div className="space-y-4">
            <div
              role="status"
              className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300"
            >
              Shop created! Send the invite link to the owner so they can set
              their password and activate the shop.
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-white/60">Invite link</p>
              <p className="break-all font-mono text-sm text-white">{inviteUrl}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" className="flex-1" onClick={onCopyInvite}>
                <Copy className="h-3.5 w-3.5" aria-hidden />
                {copied ? "Copied!" : "Copy link"}
              </Button>
              <Button asChild variant="ghost" size="sm" className="flex-1">
                <a href={inviteUrl} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> Open
                  <span className="sr-only">(opens in a new tab)</span>
                </a>
              </Button>
            </div>
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          /* Form state */
          <fetcher.Form method="post" className="space-y-4">
            {errorMessage && (
              <div
                role="alert"
                className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300"
              >
                {errorMessage}
              </div>
            )}

            <Input ref={nameRef} label="Shop name" name="name" required onChange={onNameChange} />

            <div>
              <Input
                label="Slug"
                name="slug"
                value={slug}
                onChange={(e) => onSlugChange(e.target.value)}
                placeholder="my-shop"
                autoCapitalize="off"
                spellCheck={false}
                aria-describedby="onboard-slug-hint"
              />
              <p id="onboard-slug-hint" className="mt-1 text-xs text-white/60">
                Made from the shop name; you can edit it. Final URL: {publicHost}/{slug || "my-shop"}-001 (the number
                is added for you).
              </p>
            </div>

            <Input label="Owner email" name="owner_email" type="email" required />

            <Select label="Shop type" name="type" defaultValue="beauty_parlor">
              <option value="beauty_parlor">Beauty parlour</option>
              <option value="barber_shop">Barber shop</option>
              <option value="both">Both</option>
            </Select>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Creating…" : "Create shop & generate invite"}
            </Button>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
