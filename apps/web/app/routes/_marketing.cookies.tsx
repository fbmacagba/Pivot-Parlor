import type { MetaFunction } from "@remix-run/cloudflare";

export const meta: MetaFunction = () => [
  { title: "Cookie Policy | Pivot Parlor" },
];

export default function Cookies() {
  return (
    <main className="px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="font-heading text-4xl font-bold text-white">Cookie Policy</h1>
        <p className="text-white/50 text-sm mt-2">Last updated: March 2026</p>
        {[
          ["What are cookies?", "Cookies are small text files stored on your device to remember preferences and maintain sessions."],
          ["Cookies we use", "We use only essential cookies: a session cookie (pp_session) to keep you logged in, and a localStorage key to remember dismissed announcements. No advertising or tracking cookies are used."],
          ["Managing cookies", "You can delete cookies at any time via your browser settings. Deleting the session cookie will log you out."],
          ["Third parties", "We do not use any third-party analytics or advertising cookies."],
          ["Contact", "Questions about cookies? Email dev@pivotparlor.com."],
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
