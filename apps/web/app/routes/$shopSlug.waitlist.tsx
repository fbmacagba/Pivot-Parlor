import { Form, useActionData, useLoaderData, useNavigation } from "@remix-run/react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { createApiClient } from "~/lib/api";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

export async function loader({ params }: LoaderFunctionArgs) {
  return json({ slug: params.shopSlug });
}

export async function action({ params, request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string };
  const form = await request.formData();
  try {
    await createApiClient(env.API_URL).post("/api/waitlist", {
      shop_slug: params.shopSlug,
      customer_name: form.get("name"),
      customer_email: form.get("email"),
      customer_phone: form.get("phone"),
      preferred_date: form.get("preferred_date"),
      service_id: form.get("service_id"),
    });
    return json({ success: true });
  } catch (e: unknown) {
    return json({ success: false, error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

export default function Waitlist() {
  const { slug } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-md">
        <h1 className="font-heading text-3xl font-bold text-white mb-2">Join the waitlist</h1>
        <p className="text-white/60 mb-8">We&apos;ll notify you as soon as a slot opens up.</p>

        {data?.success ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-8 text-center">
            <p className="text-2xl mb-2">🎉</p>
            <h2 className="font-heading text-xl font-bold text-white">You&apos;re on the list!</h2>
            <p className="mt-2 text-white/60">We&apos;ll reach out when a slot becomes available.</p>
          </div>
        ) : (
          <Form method="post" className="space-y-4 rounded-2xl border border-white/10 bg-dark-100 p-8">
            {data && !data.success && "error" in data && (
              <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
                {"error" in data ? (data.error as string) : "An error occurred"}
              </div>
            )}
            <Input label="Full name" name="name" required />
            <Input label="Email address" name="email" type="email" required />
            <Input label="Phone (optional)" name="phone" type="tel" />
            <Input label="Preferred date (optional)" name="preferred_date" type="date" />
            <Button type="submit" disabled={nav.state === "submitting"} className="w-full" size="lg">
              {nav.state === "submitting" ? "Joining…" : "Join waitlist →"}
            </Button>
          </Form>
        )}
      </div>
    </div>
  );
}
