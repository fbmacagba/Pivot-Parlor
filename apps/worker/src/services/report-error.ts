/**
 * Structured error reporting for Workers Logs.
 *
 * Emits a single JSON line at error level so, with [observability] enabled in
 * wrangler.toml, these events are queryable and alertable in the Cloudflare
 * dashboard (Workers & Pages → worker → Logs, filter level = error).
 *
 * Use for failures that are deliberately non-fatal to the request (email
 * sends, queue enqueues) but must never be invisible in production.
 */
export function reportError(scope: string, err: unknown, context: Record<string, unknown> = {}): void {
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(JSON.stringify({ level: "error", scope, message, ...context, stack }));
}
