export default function AdminRevenue() {
  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">Revenue</h1>
      <div className="grid gap-4 md:grid-cols-2 mb-6">
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6 h-48 flex items-center justify-center text-white/30 text-sm">Bookings per week chart</div>
        <div className="rounded-xl border border-white/10 bg-dark-100 p-6 h-48 flex items-center justify-center text-white/30 text-sm">Revenue per week chart</div>
      </div>
      <div className="rounded-xl border border-white/10 bg-dark-100 p-6 text-center text-white/40">
        Connect real data from <code className="text-gold">/api/shops/:shopId/bookings</code>
      </div>
    </div>
  );
}
