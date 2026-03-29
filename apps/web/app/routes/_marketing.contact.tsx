import { Form, useActionData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LinksFunction, MetaFunction } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

export const meta: MetaFunction = () => [
  { title: "Contact Us | Pivot Parlor" },
];

// Load Turnstile script only on this route
export const links: LinksFunction = () => [
  {
    rel: "preload",
    href: "https://challenges.cloudflare.com/turnstile/v0/api.js",
    as: "script",
  },
];

// ─── Action ───────────────────────────────────────────────────────────────────

export async function action({ request, context }: ActionFunctionArgs) {
  try {
    const env = context.env as { API_URL: string; TURNSTILE_SECRET_KEY?: string };
    const form = await request.formData();

    // ── Turnstile verification ──
    const turnstileToken = form.get("cf-turnstile-response");
    const secretKey = env.TURNSTILE_SECRET_KEY;

    if (secretKey) {
      if (!turnstileToken || typeof turnstileToken !== "string") {
        return json({ success: false, error: "Please complete the security check." }, { status: 400 });
      }

      const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret: secretKey,
          response: turnstileToken,
          remoteip: request.headers.get("CF-Connecting-IP") ?? "",
        }),
      });

      const verifyData = await verifyRes.json<{ success: boolean }>();
      if (!verifyData.success) {
        return json({ success: false, error: "Security check failed. Please try again." }, { status: 400 });
      }
    }

    // ── Submit to API ──
    const api = createApiClient(env.API_URL);
    const payload = {
      full_name:  form.get("full_name"),
      shop_name:  form.get("shop_name"),
      shop_type:  form.get("shop_type"),
      email:      form.get("email"),
      phone:      form.get("phone") || null,
      message:    form.get("message") || null,
    };

    await api.post("/api/contact", payload);
    return json({ success: true });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Unexpected error submitting the form";
    return json({ success: false, error: msg }, { status: 500 });
  }
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// Turnstile site key — replace with your real key from Cloudflare dashboard
// https://dash.cloudflare.com → Turnstile → Add site
const TURNSTILE_SITE_KEY = "0x4AAAAAACxPFNWfoxKge7a9";

export default function Contact() {
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const submitting = nav.state === "submitting";

  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      {/* Load Turnstile script */}
      <script
        src="https://challenges.cloudflare.com/turnstile/v0/api.js"
        async
        defer
      />

      <div className="mx-auto max-w-2xl">
        <div className="text-center mb-12">
          <h1 className="font-heading text-5xl font-bold text-white">
            Get your shop <span className="gradient-text">on Pivot</span>
          </h1>
          <p className="mt-4 text-white/60">
            Fill in the form below and we&apos;ll get your shop set up within 24 hours.
          </p>
          <a
            href="https://www.linkedin.com/in/fbmacagba"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-4 inline-flex items-center gap-2 border border-[#C9A84C] text-[#C9A84C] px-4 py-2 rounded-full text-sm hover:bg-[#C9A84C] hover:text-black transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
            </svg>
            Or DM us on LinkedIn
          </a>
        </div>

        {data?.success ? (
          <div className="rounded-2xl border border-gold/30 bg-dark-100 p-10 text-center">
            <div className="text-4xl mb-4">✅</div>
            <h2 className="font-heading text-2xl font-bold text-white">
              We&apos;ll be in touch soon!
            </h2>
            <p className="mt-2 text-white/60">
              Thanks for reaching out. We&apos;ll get back to you within 24 hours.
            </p>
          </div>
        ) : (
          <Form method="post" className="space-y-5 rounded-2xl border border-white/10 bg-dark-100 p-8">
            {data && !data.success && "error" in data && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">
                {data.error as string}
              </div>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <Input label="Full name"  name="full_name"  required placeholder="Jane Smith" />
              <Input label="Shop name"  name="shop_name"  required placeholder="The Barber Co." />
            </div>

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Shop type</label>
              <select
                name="shop_type"
                required
                className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold focus:border-gold"
              >
                <option value="" className="bg-dark">Select type…</option>
                <option value="beauty_parlor" className="bg-dark">Beauty parlour</option>
                <option value="barber_shop"   className="bg-dark">Barber shop</option>
                <option value="both"          className="bg-dark">Both</option>
              </select>
            </div>

            <div className="grid gap-5 sm:grid-cols-2">
              <Input label="Email address"    name="email" type="email" required placeholder="jane@yourshop.com" />
              <Input label="Phone (optional)" name="phone" type="tel"            placeholder="+44 7700 900000" />
            </div>

            <div>
              <label className="block text-sm font-medium text-white/80 mb-1.5">Message</label>
              <textarea
                name="message"
                rows={4}
                required
                placeholder="Tell us about your shop and what you need…"
                className="flex w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-gold focus:border-gold resize-none"
              />
            </div>

            {/* Turnstile widget — renders automatically, injects cf-turnstile-response hidden field */}
            <div
              className="cf-turnstile"
              data-sitekey={TURNSTILE_SITE_KEY}
              data-theme="dark"
              data-size="normal"
            />

            <Button type="submit" disabled={submitting} className="w-full" size="lg">
              {submitting ? "Sending…" : "Send enquiry →"}
            </Button>
            <p className="text-center text-xs text-white/40">
              £100 one-time setup · No monthly fees · Live in 24 hours
            </p>
          </Form>
        )}
      </div>
    </main>
  );
}
