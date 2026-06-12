/** Dispatch a request through the real worker (routes + middleware + onError). */
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

export async function dispatch(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {}
): Promise<Response> {
  const init: RequestInit = { method, headers: opts.headers ?? {} };
  if (opts.body !== undefined) {
    init.body = JSON.stringify(opts.body);
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
  }
  const request = new Request(`https://worker.test${path}`, init);
  const ctx = createExecutionContext();
  const response = await worker.fetch(request as never, env as never, ctx as never);
  await waitOnExecutionContext(ctx);
  return response as unknown as Response;
}
