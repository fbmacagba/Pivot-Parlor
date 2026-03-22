import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [{ title: "Revenue | Developer | Pivot Parlor" }];

export default function DevRevenue() {
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">Platform Revenue</h1>
      <div className="rounded-xl border border-white/10 bg-dark-100 p-8 text-center text-white/40">
        Revenue breakdown coming soon — connect to the Worker API to see real data.
      </div>
    </div>
  );
}
