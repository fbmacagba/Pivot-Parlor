import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [
  { title: "Privacy Policy | Pivot Parlor" },
];

export default function Privacy() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl prose prose-invert">
        <h1 className="font-heading text-4xl font-bold text-white">Privacy Policy</h1>
        <p className="text-white/50 text-sm">Last updated: March 2026</p>
        {[
          ["What we collect", "We collect your name, email address, shop details, and booking data to operate the platform. We do not sell your data."],
          ["How we use it", "Your data is used to provide the booking and scheduling service, send reminders, and calculate commissions."],
          ["Data storage", "Data is stored in Cloudflare D1 on Cloudflare's European infrastructure. Each shop's customer data is logically isolated."],
          ["GDPR rights", "You have the right to access, correct, or delete your personal data. Contact dev@pivotparlor.com to make a request."],
          ["Cookies", "We use only essential session cookies. No tracking or advertising cookies are used. See our Cookie Policy for details."],
          ["Contact", "For privacy questions, email dev@pivotparlor.com or write to us at Moselle Avenue, London, UK, N22 6ET."],
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
