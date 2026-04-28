import { redirect } from "@remix-run/cloudflare";
import type { ActionFunctionArgs } from "@remix-run/cloudflare";
import { clearSessionCookie } from "~/lib/auth";

export async function action(args: ActionFunctionArgs) {
  void args;
  return redirect("/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}

export async function loader() {
  return redirect("/login", {
    headers: { "Set-Cookie": clearSessionCookie() },
  });
}
