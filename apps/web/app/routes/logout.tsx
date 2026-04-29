import { redirect } from "@remix-run/cloudflare";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { clearHostOnlySessionCookie, clearSessionCookie } from "~/lib/auth";

function prodCookieScope(env: { APP_DOMAIN?: string }): boolean {
  const d = (env.APP_DOMAIN ?? "").trim();
  return d !== "" && d !== "localhost";
}

function clearAllSessionCookies(env: { APP_DOMAIN?: string }): Headers {
  const isProd = prodCookieScope(env);
  const h = new Headers();
  if (isProd) {
    h.append("Set-Cookie", clearHostOnlySessionCookie(true));
  }
  h.append("Set-Cookie", clearSessionCookie(isProd));
  return h;
}

export async function action({ context }: ActionFunctionArgs) {
  const env = context.env as { APP_DOMAIN?: string };
  return redirect("/login", { headers: clearAllSessionCookies(env) });
}

export async function loader({ context }: LoaderFunctionArgs) {
  const env = context.env as { APP_DOMAIN?: string };
  return redirect("/login", { headers: clearAllSessionCookies(env) });
}
