import { useEffect, useRef, useState } from "react";

/**
 * Cloudflare Turnstile, rendered EXPLICITLY after hydration.
 *
 * The implicit form (a `.cf-turnstile` div plus a plain api.js script)
 * rewrites that div as soon as the script runs, which can be before React
 * hydrates it. On production /contact that broke hydration on every visit
 * (React #418, #423), React re-rendered on the client, and the widget was
 * orphaned, so no token was ever issued.
 *
 * Here the server renders an empty container that implicit render cannot
 * find. The explicit-render script loads once, and the widget is rendered into
 * the container from an effect. Turnstile adds its hidden
 * `cf-turnstile-response` input inside the container, so a surrounding form
 * submits the token.
 */

export const TURNSTILE_SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** The "Pivot Parlor Contact Form" widget (managed mode; hostname
 *  pivotparlor.com). Shop sites live at pivotparlor.com/<slug>, and the
 *  chatbot worker's secret pairs with this key (probed 2026-11-11), so the
 *  contact form and the shop chat share it. */
export const TURNSTILE_SITE_KEY = "0x4AAAAAACxPFNWfoxKge7a9";

interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | null | undefined;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

function turnstileApi(): TurnstileApi | undefined {
  return (window as unknown as { turnstile?: TurnstileApi }).turnstile;
}

/** The one explicit-render script on the page, added if it is not there yet. */
function turnstileScript(): HTMLScriptElement {
  const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT_SRC}"]`);
  if (existing) return existing;
  const script = document.createElement("script");
  script.src = TURNSTILE_SCRIPT_SRC;
  script.async = true;
  document.head.appendChild(script);
  return script;
}

export function TurnstileWidget({
  siteKey,
  theme = "auto",
  size = "normal",
  resetSignal,
  className,
  appearance,
  onToken,
  messageClassName = "mt-2 text-sm text-red-400",
}: {
  siteKey: string;
  theme?: "light" | "dark" | "auto";
  size?: "normal" | "flexible" | "compact";
  /** Tokens are single-use: pass something that changes after each
   *  submission (the action's data) and the widget issues a fresh one. */
  resetSignal?: unknown;
  className?: string;
  /** "interaction-only" keeps the widget invisible unless Cloudflare needs
   *  the visitor to tick it. Omitted, Turnstile's default ("always") applies. */
  appearance?: "always" | "execute" | "interaction-only";
  /** Each fresh token, then null once it errors or expires, for callers that
   *  send the token themselves rather than through a form field. */
  onToken?: (token: string | null) => void;
  /** Classes for the failure message (the default suits a dark form). */
  messageClassName?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);
  const [failed, setFailed] = useState(false);
  // Read through a ref, so a new callback never re-renders the widget.
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;

  useEffect(() => {
    let active = true;
    const render = () => {
      const api = turnstileApi();
      if (!active || !api || !containerRef.current || widgetId.current) return;
      widgetId.current =
        api.render(containerRef.current, {
          sitekey: siteKey,
          theme,
          size,
          ...(appearance ? { appearance } : {}),
          callback: (token: string) => {
            if (!active) return;
            setFailed(false);
            onTokenRef.current?.(token);
          },
          "expired-callback": () => {
            if (active) onTokenRef.current?.(null);
          },
          // Without this, Turnstile throws its errors uncaught and the
          // visitor sees nothing. Retries stay automatic (retry: auto), so a
          // later success clears the message. Returning true marks it handled.
          "error-callback": () => {
            if (!active) return true;
            setFailed(true);
            onTokenRef.current?.(null);
            return true;
          },
        }) ?? null;
    };
    let script: HTMLScriptElement | null = null;
    if (turnstileApi()) render();
    else {
      script = turnstileScript();
      script.addEventListener("load", render);
    }
    return () => {
      active = false;
      script?.removeEventListener("load", render);
      if (widgetId.current) turnstileApi()?.remove(widgetId.current);
      widgetId.current = null;
    };
  }, [siteKey, theme, size, appearance]);

  const lastSignal = useRef(resetSignal);
  useEffect(() => {
    if (lastSignal.current === resetSignal) return;
    lastSignal.current = resetSignal;
    if (widgetId.current) turnstileApi()?.reset(widgetId.current);
  }, [resetSignal]);

  // Turnstile owns the inner container's contents, so React renders the
  // message beside it, never inside it.
  return (
    <div className={className}>
      <div ref={containerRef} />
      {failed && (
        <p role="alert" className={messageClassName}>
          The security check didn&apos;t complete. If this message stays, refresh the page and try again.
        </p>
      )}
    </div>
  );
}
