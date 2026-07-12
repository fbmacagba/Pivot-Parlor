import type { ReactNode } from "react";

export function ShopLegalDocument({
  title,
  shopName,
  address,
  children,
}: {
  title: string;
  shopName: string;
  /** Business address from shop settings — shown in the policy when available */
  address?: string | null;
  children: ReactNode;
}) {
  const today = new Date();
  const lastUpdated = today.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <main className="px-4 py-16 md:px-6 md:py-24">
      <article className="mx-auto max-w-3xl">
        <h1 className="pp-heading text-3xl font-bold tracking-tight text-[color:var(--st-ink)] md:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-[color:var(--st-ink-50)]">Last updated: {lastUpdated}</p>

        {address ? (
          <div className="mt-4 rounded-[var(--st-r-sm)] border border-[color:var(--st-line-10)] bg-[color:var(--st-card-5)] px-4 py-3 text-sm text-[color:var(--st-ink-60)]">
            <span className="font-medium text-[color:var(--st-ink-80)]">{shopName}</span>
            <br />
            {address}
          </div>
        ) : null}

        <div className="mt-10 space-y-5 text-base leading-relaxed text-[color:var(--st-ink-75)]">{children}</div>

        <p className="mt-12 text-sm text-[color:var(--st-ink-45)]">
          Questions about this policy? Contact <strong className="text-[color:var(--st-ink-60)]">{shopName}</strong> using the
          details on our main page{address ? ` or at the address above` : ""}.
        </p>
      </article>
    </main>
  );
}
