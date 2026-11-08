import { redirect } from "@remix-run/cloudflare";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { createApiClient } from "~/lib/api";
import { clearHostOnlySessionCookie, clearSessionCookie, getSessionToken } from "~/lib/auth";

type LogoutEnv = { API_URL: string; APP_DOMAIN?: string };

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

/** End the server session too: the API keeps `session:<token>` in KV until
 *  POST /auth/logout deletes it, so clearing only the cookie left a copied
 *  token valid for its full lifetime. Best effort: signing out of the browser
 *  never waits on, or fails because of, the API. */
async function revokeSession(request: Request, env: LogoutEnv): Promise<void> {
  const token = getSessionToken(request);
  if (!token) return;
  try {
    await createApiClient(env.API_URL, token).post("/auth/logout");
  } catch (e) {
    console.error("[logout] session revoke failed:", e instanceof Error ? e.name : "unknown");
  }
}

async function signOut(request: Request, env: LogoutEnv): Promise<Response> {
  await revokeSession(request, env);
  return redirect("/login", { headers: clearAllSessionCookies(env) });
}

export async function action({ request, context }: ActionFunctionArgs) {
  return signOut(request, context.env as LogoutEnv);
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  return signOut(request, context.env as LogoutEnv);
}
