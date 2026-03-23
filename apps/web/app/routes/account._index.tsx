import { useOutletContext } from "@remix-run/react";

type Me = {
  id: string;
  name: string | null;
  email: string;
  role: string;
};

export default function AccountIndex() {
  const { me } = useOutletContext<{ me: Me }>();
  const displayName = me.name?.trim() || "Customer";

  return (
    <div className="mx-auto max-w-2xl space-y-10">
      <div>
        <h1 className="font-heading text-2xl font-bold text-white">My account</h1>
        <p className="mt-1 text-sm text-white/55">Signed in as {me.email}</p>
      </div>

      <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">Profile</h2>
        <dl className="mt-4 space-y-3 text-sm">
          <div>
            <dt className="text-white/50">Name</dt>
            <dd className="mt-0.5 text-white">{displayName}</dd>
          </div>
          <div>
            <dt className="text-white/50">Email</dt>
            <dd className="mt-0.5 text-white">{me.email}</dd>
          </div>
        </dl>
      </section>

      <section className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-lg font-semibold text-white">My bookings</h2>
        <p className="mt-3 text-sm text-white/55">Coming soon — you&apos;ll be able to view and manage your appointments here.</p>
      </section>
    </div>
  );
}
