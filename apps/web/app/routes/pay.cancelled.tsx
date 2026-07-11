import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [{ title: "Payment cancelled | Pivot Parlor" }];

export default function PayCancelled() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#0D0D0D] px-6">
      <div className="max-w-sm rounded-2xl border border-white/10 bg-white/5 p-8 text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-500/15 text-3xl">
          !
        </div>
        <h1 className="font-heading text-2xl font-bold text-white">Payment cancelled</h1>
        <p className="mt-2 text-sm text-white/60">
          No money was taken. Ask the staff to scan again, or pay another way at the counter.
        </p>
      </div>
    </main>
  );
}
