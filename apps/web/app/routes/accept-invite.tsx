import { Form, useActionData, useNavigation, useSearchParams } from "@remix-run/react";
import type { ActionFunctionArgs, MetaFunction } from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { createApiClient } from "~/lib/api";
import { buildSessionCookie, decodeToken } from "~/lib/auth";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";

export const meta: MetaFunction = () => [{ title: "Accept Invite | Pivot Parlor" }];

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string; APP_DOMAIN: string };
  const form = await request.formData();
  const token = form.get("token") as string;
  const name = form.get("name") as string;
  const password = form.get("password") as string;

  const api = createApiClient(env.API_URL);
  try {
    const result = await api.post<{ token: string; role: string }>("/auth/accept-invite", {
      token, name, password,
    });
    const payload = decodeToken(result.token);
    const dest = payload?.role === "admin" ? "/admin" : "/staff";
    return redirect(dest, {
      headers: { "Set-Cookie": buildSessionCookie(result.token, env.APP_DOMAIN !== "localhost") },
    });
  } catch (err: unknown) {
    return json({ error: err instanceof Error ? err.message : "Invalid invite" }, { status: 400 });
  }
}

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const data = useActionData<typeof action>();
  const nav = useNavigation();

  return (
    <div className="flex min-h-screen items-center justify-center bg-dark px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-heading text-2xl font-bold text-white">Pivot <span className="text-gold">Parlor</span></p>
          <h1 className="mt-2 text-xl font-semibold text-white">Set up your account</h1>
          <p className="mt-1 text-sm text-white/50">You&apos;ve been invited to join a shop.</p>
        </div>
        <Form method="post" className="space-y-4 rounded-2xl border border-white/10 bg-dark-100 p-8">
          <input type="hidden" name="token" value={params.get("token") ?? ""} />
          {data?.error && (
            <div className="rounded-lg bg-red-500/10 border border-red-500/20 px-4 py-3 text-sm text-red-400">{data.error}</div>
          )}
          <Input label="Your name" name="name" required />
          <Input label="Password" name="password" type="password" required />
          <Button type="submit" disabled={nav.state === "submitting"} className="w-full" size="lg">
            {nav.state === "submitting" ? "Setting up…" : "Activate account →"}
          </Button>
        </Form>
      </div>
    </div>
  );
}
