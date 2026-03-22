import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "@remix-run/cloudflare";
import { json, redirect } from "@remix-run/cloudflare";
import { useActionData } from "@remix-run/react";
import { createApiClient } from "~/lib/api";
import {
  buildSessionCookie,
} from "~/lib/auth";

export const meta: MetaFunction = () => [
  { title: "Developer Login | Pivot Parlor" },
];

export async function loader({ request, context }: LoaderFunctionArgs) {
  // Important: do not redirect from the login page based on an existing cookie.
  // Redirecting here can create infinite loops when JWT_SECRET/env bindings
  // are missing or when the cookie contains an invalid/stale token.
  //
  // Protected routes like `/dev` will handle auth properly.
  return json({});
}

export async function action({ request, context }: ActionFunctionArgs) {
  const env = context.env as { API_URL: string; APP_DOMAIN: string };
  const form = await request.formData();
  const email = (form.get("email") as string | null) ?? "";
  const password = (form.get("password") as string | null) ?? "";

  if (!email || !password) {
    return json(
      { error: "Email and password are required." },
      { status: 400 }
    );
  }

  const api = createApiClient(env.API_URL);

  try {
    const result = await api.post<{ token: string; role: string }>(
      "/auth/login",
      { email, password }
    );

    if (result.role !== "developer") {
      return json(
        { error: "You do not have developer access to this area." },
        { status: 403 }
      );
    }

    const isProd = env.APP_DOMAIN !== "localhost";
    return redirect("/dev/dashboard", {
      headers: {
        "Set-Cookie": buildSessionCookie(result.token, isProd),
      },
    });
  } catch (err: unknown) {
    const msg =
      err instanceof Error ? err.message : "Invalid email or password.";
    return json({ error: msg }, { status: 401 });
  }
}

export default function DevLogin() {
  const data = useActionData<typeof action>();

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0D0D0D] px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <p className="font-heading text-2xl font-bold text-white">
            Pivot <span className="text-[#C9A84C]">Parlor</span>
          </p>
          <h1 className="mt-2 text-xl font-semibold text-white">
            Developer login
          </h1>
          <p className="mt-1 text-sm text-white/60">
            Sign in to access the developer dashboard.
          </p>
        </div>

        {/* Use a plain HTML form to guarantee native submission even if Remix's JS enhancement is blocked. */}
        <form
          method="post"
          action="/dev/login"
          className="space-y-4 rounded-2xl border border-white/10 bg-[#111111] p-8"
        >
          {data?.error && (
            <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              {data.error}
            </div>
          )}

          <div className="space-y-1.5">
            <label
              htmlFor="email"
              className="block text-sm font-medium text-white/80"
            >
              Email address
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              className="block h-10 w-full rounded-lg border border-white/20 bg-black/20 px-3 text-sm text-white placeholder:text-white/40 focus:border-[#C9A84C] focus:outline-none focus:ring-2 focus:ring-[#C9A84C]"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="password"
              className="block text-sm font-medium text-white/80"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
              className="block h-10 w-full rounded-lg border border-white/20 bg-black/20 px-3 text-sm text-white placeholder:text-white/40 focus:border-[#C9A84C] focus:outline-none focus:ring-2 focus:ring-[#C9A84C]"
            />
          </div>

          <button
            type="submit"
            className="flex h-10 w-full items-center justify-center rounded-lg bg-[#C9A84C] text-sm font-semibold text-black transition-colors hover:bg-[#e1c66a]"
          >
            Sign in →
          </button>
        </form>
      </div>
    </div>
  );
}

