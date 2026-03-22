import { Form } from "@remix-run/react";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

export default function StaffAvailability() {
  const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

  return (
    <div className="space-y-6 max-w-2xl">
      <h1 className="font-heading text-2xl font-bold text-white">My Availability</h1>

      <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-base font-semibold text-white mb-4">Weekly schedule (set by manager)</h2>
        <div className="space-y-2 text-sm text-white/60">
          {days.map((d) => (
            <div key={d} className="flex items-center gap-4">
              <span className="w-24 font-medium text-white/80">{d}</span>
              <span className="text-white/40">Off</span>
            </div>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-white/10 bg-dark-100 p-6">
        <h2 className="font-heading text-base font-semibold text-white mb-4">Request time off</h2>
        <Form method="post" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="From date" name="from" type="date" />
            <Input label="To date" name="to" type="date" />
          </div>
          <div>
            <label className="block text-sm font-medium text-white/80 mb-1.5">Reason</label>
            <textarea
              name="reason"
              rows={3}
              className="flex w-full rounded-lg border border-white/20 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:ring-2 focus:ring-gold resize-none"
              placeholder="Optional reason…"
            />
          </div>
          <Button type="submit" size="sm">Submit request</Button>
        </Form>
      </div>
    </div>
  );
}
