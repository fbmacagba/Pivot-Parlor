import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// Same test-boundary stubs as VisualManager.test.tsx: the panel under test
// takes everything as props, so only module loading needs them.
vi.mock("@remix-run/react", () => ({ useFetcher: () => ({ state: "idle", data: undefined, load() {}, submit() {} }) }));
vi.mock("lucide-react", () => {
  const Icon = () => null;
  return { ExternalLink: Icon, Loader2: Icon };
});
import { SiteCandidatePanel } from "./SiteCandidateCard";

const CANDIDATE = {
  job_id: "job-A",
  created_at: "2026-11-06T10:05:00Z",
  services_unchanged: true,
  headline: "New headline",
};
const noop = () => {};
const base = {
  candidate: CANDIDATE,
  previewHref: "/real-barber?preview=candidate",
  busy: null,
  confirmingDiscard: false,
  notice: null,
  onPublish: noop,
  onDiscard: noop,
  onConfirmDiscard: noop,
  onCancelDiscard: noop,
} as const;

const render = (props: Partial<Parameters<typeof SiteCandidatePanel>[0]> = {}) =>
  renderToStaticMarkup(<SiteCandidatePanel {...base} {...props} />);

describe("SiteCandidatePanel", () => {
  it("renders nothing while no version is waiting", () => {
    expect(render({ candidate: null })).toBe("");
  });

  it("says the live site is unchanged and offers Preview, Publish and Discard", () => {
    const html = render();
    expect(html).toContain("A new version of your site is ready");
    expect(html).toContain("Made 6 Nov, 10:05.");
    expect(html).toContain("Your live site has not changed.");
    expect(html).toContain('href="/real-barber?preview=candidate"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("(opens in a new tab)");
    expect(html).toMatch(/<button[^>]*>Publish<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Publish/);
    expect(html).toMatch(/<button[^>]*>Discard<\/button>/);
    expect(html).not.toContain("—"); // no em-dashes in user-facing text
  });

  it("blocks Publish, and says why, when the menu changed", () => {
    const html = render({ candidate: { ...CANDIDATE, services_unchanged: false } });
    expect(html).toContain("Your services changed after this version was made");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Publish<\/button>/);
    expect(html).toMatch(/<button[^>]*>Discard<\/button>/);
  });

  it("asks before discarding", () => {
    const html = render({ confirmingDiscard: true });
    expect(html).toContain("Discard this version?");
    expect(html).toContain("Keep it");
  });

  it("shows progress while publishing and disables every action", () => {
    const html = render({ busy: "publish" });
    expect(html).toContain("Publishing");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Discard<\/button>/);
  });

  it("gives an error its context when no version can be shown", () => {
    const html = render({ candidate: null, notice: { tone: "error", text: "This version can no longer be shown. Regenerate the site." } });
    expect(html).toContain("New version of your site");
    expect(html).toContain('role="alert"');
  });

  it("confirms a finished publish on its own line", () => {
    const html = render({ candidate: null, notice: { tone: "ok", text: "Published. Your site now shows the new version." } });
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<section");
  });
});
