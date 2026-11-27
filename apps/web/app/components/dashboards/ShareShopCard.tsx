import { useEffect, useRef, useState } from "react";
import QRCode from "react-qr-code";
import { Check, Copy, QrCode, Share2 } from "lucide-react";
import { Button } from "~/components/ui/Button";

interface ShareShopCardProps {
  shopUrl: string;
  shopName: string;
}

/**
 * "Share your shop" card for the admin and staff dashboard homes: copy link,
 * native share sheet (where the browser supports it), and an on-screen QR
 * code sized for someone else to scan straight off the device.
 */
export function ShareShopCard({ shopUrl, shopName }: ShareShopCardProps) {
  const [copied, setCopied] = useState(false);
  // True once the browser has refused the clipboard: the address is selected
  // on screen instead, and the card says how to copy it by hand.
  const [copyRefused, setCopyRefused] = useState(false);
  const urlRef = useRef<HTMLAnchorElement>(null);
  const [showQR, setShowQR] = useState(false);
  // navigator is SSR-unsafe and share support varies; resolve after hydration
  // so server and first client render agree.
  const [canShare, setCanShare] = useState(false);

  useEffect(() => {
    setCanShare(
      typeof navigator !== "undefined" && typeof navigator.share === "function",
    );
  }, []);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shopUrl);
      setCopyRefused(false);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The clipboard can be unavailable (permissions, http, an in-app
      // browser). Never fail silently: select the address so one long press
      // (or Ctrl+C) copies it, and say so.
      setCopied(false);
      setCopyRefused(true);
      const link = urlRef.current;
      const selection = typeof window !== "undefined" ? window.getSelection() : null;
      if (link && selection) {
        const range = document.createRange();
        range.selectNodeContents(link);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }

  async function nativeShare() {
    try {
      await navigator.share({ title: shopName, url: shopUrl });
    } catch {
      // User dismissed the share sheet; nothing to do.
    }
  }

  return (
    <div className="rounded-xl border border-white/10 bg-dark-100 p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="font-heading text-lg font-semibold text-white">
            Share your shop
          </h2>
          <p className="mt-0.5 text-sm text-white/60">
            Send customers your booking page, or show the QR code for them to
            scan from this screen.
          </p>
          <a
            ref={urlRef}
            href={shopUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block break-all text-sm text-gold hover:underline"
          >
            {shopUrl}
          </a>
          {/* Always in the page, so a screen reader hears the outcome arrive. */}
          <p role="status" className="mt-1 min-h-[1.25rem] text-sm text-white/70">
            {copied
              ? "Link copied."
              : copyRefused
                ? "This browser would not copy the link. It is selected above: press and hold it to copy."
                : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={copyLink}>
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden />
            ) : (
              <Copy className="h-3.5 w-3.5" aria-hidden />
            )}
            {copied ? "Copied" : "Copy link"}
          </Button>
          {canShare && (
            <Button variant="secondary" size="sm" onClick={nativeShare}>
              <Share2 className="h-3.5 w-3.5" aria-hidden />
              Share
            </Button>
          )}
          <Button
            variant={showQR ? "default" : "outline"}
            size="sm"
            onClick={() => setShowQR((v) => !v)}
            aria-expanded={showQR}
          >
            <QrCode className="h-3.5 w-3.5" aria-hidden />
            {showQR ? "Hide QR code" : "Show QR code"}
          </Button>
        </div>
      </div>

      {showQR && (
        <div className="mt-5 flex flex-col items-center gap-3 border-t border-white/10 pt-5">
          {/* QR codes need a light background to scan reliably on dark themes. */}
          <div className="rounded-xl bg-white p-4">
            <QRCode
              value={shopUrl}
              size={220}
              aria-label={`QR code linking to ${shopName}`}
            />
          </div>
          <p className="max-w-xs text-center text-xs text-white/60">
            Point a phone camera at the code to open {shopName}. Turn up your
            screen brightness if it does not scan first time.
          </p>
        </div>
      )}
    </div>
  );
}
