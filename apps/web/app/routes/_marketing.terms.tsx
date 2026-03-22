import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [
  { title: "Terms of Service | Pivot Parlor" },
];

export default function Terms() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">Terms of Service</h1>
        <p className="text-white/50 text-sm mt-2">Last updated: March 2026</p>
        {[
          ["Acceptance", "By using Pivot Parlor you agree to these terms. If you do not agree, do not use the platform."],
          ["Service description", "Pivot Parlor provides an online booking platform for beauty and barber shops. We build, host, and maintain your booking page."],
          ["Commission", "We charge 10% commission on completed bookings only. Cancelled and no-show bookings are not charged."],
          ["Shop owner obligations", "You are responsible for the accuracy of your shop details, services, and staff information."],
          ["Intellectual property", "AI-generated brand content is owned by your shop. Our platform software remains our property."],
          ["Termination", "Either party may terminate with 30 days written notice. Pending bookings will be fulfilled before termination."],
          ["Liability", "We are not liable for indirect or consequential losses. Our maximum liability is limited to the commission paid in the preceding 3 months."],
          ["Governing law", "These terms are governed by the laws of England and Wales."],
        ].map(([title, body]) => (
          <section key={title as string} className="mt-8">
            <h2 className="font-heading text-xl font-semibold text-white">{title}</h2>
            <p className="mt-2 text-white/70">{body}</p>
          </section>
        ))}
      </div>
    </main>
  );
}
