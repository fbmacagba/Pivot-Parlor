export default function AdminSchedule() {
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const staff = ["Alice", "Bob", "Carol"];

  return (
    <div>
      <h1 className="font-heading text-2xl font-bold text-white mb-6">Schedule</h1>
      <div className="rounded-xl border border-white/10 bg-dark-100 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/10">
              <th className="px-4 py-3 text-left text-xs font-semibold text-white/40">Staff</th>
              {days.map((d) => (
                <th key={d} className="px-4 py-3 text-left text-xs font-semibold text-white/40">{d}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {staff.map((name) => (
              <tr key={name}>
                <td className="px-4 py-3 font-medium text-white">{name}</td>
                {days.map((d) => (
                  <td key={d} className="px-4 py-3">
                    <input
                      type="text"
                      placeholder="09:00-17:00"
                      className="w-28 rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-white placeholder:text-white/20 focus:border-gold focus:outline-none"
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
