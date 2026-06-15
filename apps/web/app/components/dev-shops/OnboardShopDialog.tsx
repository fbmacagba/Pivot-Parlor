// New-shop onboarding dialog for the developer "Shops" dashboard.
// Extracted from dev.shops.tsx (T7.7 class-2) — presentational; all state stays
// in the route and is passed in. Behavior-identical. Covered by
// shop-onboarding.spec.ts + dev-dashboard.spec.ts (create + invite link + copy).
import type { FetcherWithComponents } from "@remix-run/react";
import type { ChangeEvent, RefObject } from "react";
import { Copy, ExternalLink, Plus } from "lucide-react";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
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
  nameRef: RefObject<HTMLInputElement>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Shop
        </Button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Onboard new shop</DialogTitle>
        </DialogHeader>

        {/* ── Success state — show payment link or invite link ── */}
        {checkoutUrl ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
              Shop created! Send the £100 payment link to the owner. Once paid, the invite link will activate.
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="mb-2 text-xs font-medium text-white/50 uppercase tracking-wider">
                Payment link (£100)
              </p>
              <p className="break-all text-sm text-white font-mono">{checkoutUrl}</p>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="flex-1"
                onClick={() => onCopyPayment(checkoutUrl)}
              >
                <Copy className="h-3.5 w-3.5 mr-1" />
                {copied ? "Copied!" : "Copy Payment Link"}
              </Button>
              <a href={checkoutUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
                <Button type="button" variant="ghost" size="sm" className="w-full">
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                </Button>
              </a>
            </div>
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : inviteUrl ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-3 text-sm text-green-300">
              Shop created! Send the invite link to the owner so they can set
              their password and activate the shop.
            </div>
            <div className="rounded-lg border border-white/10 bg-white/5 p-3">
              <p className="mb-2 text-xs font-medium text-white/50 uppercase tracking-wider">
                Invite link
              </p>
              <p className="break-all text-sm text-white font-mono">{inviteUrl}</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="ghost" size="sm" className="flex-1" onClick={onCopyInvite}>
                <Copy className="h-3.5 w-3.5 mr-1" />
                {copied ? "Copied!" : "Copy link"}
              </Button>
              <a href={inviteUrl} target="_blank" rel="noopener noreferrer" className="flex-1">
                <Button type="button" variant="ghost" size="sm" className="w-full">
                  <ExternalLink className="h-3.5 w-3.5 mr-1" /> Open
                </Button>
              </a>
            </div>
            <Button type="button" className="w-full" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        ) : (
          /* ── Form state ── */
          <fetcher.Form method="post" className="space-y-4">
            {errorMessage && (
              <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
                {errorMessage}
              </div>
            )}

            <Input ref={nameRef} label="Shop name" name="name" required onChange={onNameChange} />

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">
                Slug
                <span className="ml-1.5 text-xs text-white/40">(auto-generated, editable)</span>
              </label>
              <input
                name="slug"
                value={slug}
                onChange={(e) => onSlugChange(e.target.value)}
                placeholder="my-shop"
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white placeholder-white/30 focus:outline-none focus:ring-2 focus:ring-gold"
              />
              <p className="mt-1 text-xs text-white/30">
                Final URL: pivotparlor.com/
                <span className="text-white/50">{slug || "my-shop"}</span>-001
              </p>
            </div>

            <Input label="Owner email" name="owner_email" type="email" required />

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Shop type</label>
              <select
                name="type"
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold"
              >
                <option value="beauty_parlor" className="bg-dark">Beauty parlour</option>
                <option value="barber_shop" className="bg-dark">Barber shop</option>
                <option value="both" className="bg-dark">Both</option>
              </select>
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? "Creating…" : "Create shop & generate invite →"}
            </Button>
          </fetcher.Form>
        )}
      </DialogContent>
    </Dialog>
  );
}
