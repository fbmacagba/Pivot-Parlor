import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VisualManager, uploadVisual, type VisualsData } from "./VisualManager";

// VisualManager calls useRevalidator(); provide it without a Router but keep
// every other @remix-run/react export real so nothing transitive breaks.
// The component only uses useRevalidator, so the whole module is stubbed: loading
// the real Remix runtime here would require React from the monorepo root, where
// there is none (React 18 lives in this app's own node_modules).
vi.mock("@remix-run/react", () => ({
  useRevalidator: () => ({ revalidate: () => {}, state: "idle" as const }),
}));

// FORCED DEVIATION from the brief's verbatim test (see task-11-report.md):
// lucide-react's published CJS bundle calls the bare `require("react")` at
// module scope. In this monorepo the root hoists React 19 (for tooling)
// alongside apps/web's own React 18; that nested require resolves the
// hoisted root copy, and react-dom/server (18) then rejects the icon's
// element as "not a valid React child" (renderToStaticMarkup only, this is
// invisible in the real app because Vite's production build never takes
// this CJS require path). No vitest.config.ts combination of dedupe /
// resolve.alias / ssr.noExternal / server.deps.inline (including inlining
// everything) intercepts a nested `require()` inside an already-CJS module,
// so the fix has to be at the test boundary. None of the assertions below
// depend on icon markup (they check button/badge text), so stubbing every
// icon as a no-op component costs no coverage.
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { Check: Icon, Loader2: Icon, Sparkles: Icon, Trash2: Icon, Upload: Icon };
});

const DATA: VisualsData = {
  hero: { url: "https://x/hero.png", locked: true },
  logo: { url: null, locked: false },
  catalog: ["https://x/c0.png"],
  services: [{ id: "s1", name: "Skin Fade", image_url: null }],
};

describe("VisualManager render", () => {
  it("shows a Custom badge on a locked visual and the service name", () => {
    const html = renderToStaticMarkup(
      <VisualManager shopId="shop1" apiUrl="https://api" role="developer" {...DATA} />
    );
    expect(html).toContain("Custom");
    expect(html).toContain("Skin Fade");
  });

  it("shows Regenerate/Remove for developer but not for admin", () => {
    const dev = renderToStaticMarkup(
      <VisualManager shopId="shop1" apiUrl="https://api" role="developer" {...DATA} />
    );
    const admin = renderToStaticMarkup(
      <VisualManager shopId="shop1" apiUrl="https://api" role="admin" {...DATA} />
    );
    expect(dev).toContain("Regenerate");
    expect(dev).toContain("Remove");
    expect(admin).toContain("Upload");
    expect(admin).not.toContain("Regenerate");
    expect(admin).not.toContain("Remove");
  });
});

describe("uploadVisual", () => {
  it("calls upload-image then save-image with the same type", async () => {
    const calls: Array<{ url: string; type: string | null }> = [];
    const doFetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/upload-image")) {
        const fd = init?.body as FormData;
        calls.push({ url, type: String(fd.get("type")) });
        return new Response(JSON.stringify({ imageUrl: "https://x/up.png" }), { status: 200 });
      }
      const parsed = JSON.parse(String(init?.body ?? "{}")) as { type?: string; imageUrl?: string };
      calls.push({ url, type: parsed.type ?? null });
      expect(parsed.imageUrl).toBe("https://x/up.png");
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const file = new File([new Uint8Array([1, 2, 3])], "x.png", { type: "image/png" });
    const result = await uploadVisual("shop1", "service:s1", file, doFetch as unknown as typeof fetch);

    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/shops/shop1/upload-image",
      "/api/shops/shop1/save-image",
    ]);
    expect(calls[0].type).toBe("service:s1");
    expect(calls[1].type).toBe("service:s1");
  });
});
