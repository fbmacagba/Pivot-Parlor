import type { ReactNode } from "react";

export function ShopLegalDocument({
  title,
  shopName,
  children,
}: {
  title: string;
  shopName: string;
  children: ReactNode;
}) {
  return (
    <main className="px-4 py-16 md:px-6 md:py-24">
      <article className="mx-auto max-w-3xl">
        <h1 className="pp-heading text-3xl font-bold tracking-tight text-white md:text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-white/50">Last updated: {new Date().getFullYear()}</p>
        <div className="mt-10 space-y-5 text-base leading-relaxed text-white/75">{children}</div>
        <p className="mt-12 text-sm text-white/45">
          Questions about these policies? Contact {shopName} using the details on our main page.
        </p>
      </article>
    </main>
  );
}
