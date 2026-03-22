import { Form } from "@remix-run/react";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

export default function AdminSettings() {
  return (
    <div className="space-y-8 max-w-2xl">
      <h1 className="font-heading text-2xl font-bold text-white">Settings</h1>

      {/* Shop profile */}
      <section className="rounded-xl border border-white/10 bg-dark-100 p-6 space-y-4">
        <h2 className="font-heading text-lg font-semibold text-white">Shop profile</h2>
        <Form method="post" className="space-y-4">
          <Input label="Shop name" name="name" />
          <Input label="Phone" name="phone" type="tel" />
          <Input label="Address" name="address" />
          <Button type="submit" size="sm">Save changes</Button>
        </Form>
      </section>

      {/* Notification settings */}
      <section className="rounded-xl border border-white/10 bg-dark-100 p-6 space-y-4">
        <h2 className="font-heading text-lg font-semibold text-white">Reminders</h2>
        <div>
          <label className="block text-sm font-medium text-white/80 mb-1.5">Send reminder</label>
          <select className="flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold max-w-xs">
            <option className="bg-dark" value="24h">24 hours before</option>
            <option className="bg-dark" value="2h">2 hours before</option>
            <option className="bg-dark" value="both">Both</option>
          </select>
        </div>
        <Button size="sm">Save</Button>
      </section>
    </div>
  );
}
