import { formatMadeAt } from "~/lib/siteCandidate";

/**
 * Platform bar above a shop page opened with ?preview=candidate. Drawn in
 * Pivot Parlor's own colours, not the shop's, so it can never be read as part
 * of the site, and in normal flow above the shop's sticky header, so it never
 * covers the page. Publish and Discard stay on the dashboard, one place.
 */
export function CandidatePreviewBar(props: {
  created_at: string;
  services_unchanged: boolean;
  dashboard_href: string;
}) {
  const madeAt = formatMadeAt(props.created_at);
  return (
    <div
      role="region"
      aria-label="Preview"
      className="pp-safe-x border-b border-[#C9A84C]/60 bg-[#0D0D0D] px-4 py-3 font-sans text-sm text-white/85"
    >
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <p className="m-0">
          <strong className="font-semibold text-[#C9A84C]">Preview.</strong> This is the new version
          {madeAt ? `, made ${madeAt}` : ""}. Your live site has not changed.
          {props.services_unchanged ? null : " Your services changed since it was made, so it cannot be published as it is."}
        </p>
        <a href={props.dashboard_href} className="font-medium text-[#C9A84C] underline underline-offset-4 hover:text-white">
          Publish or discard
        </a>
      </div>
    </div>
  );
}
