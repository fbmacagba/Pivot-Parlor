/**
 * Pip, the marketing site's chat widget, answered for the website over its
 * MARKETING_CHAT service binding (apps/web/wrangler.toml). The website keeps
 * the per-visitor hourly limit and its body checks; this answers the cleaned
 * turns so each reply is audited and in the cost log
 * (services/marketing-chat.ts has the details).
 *
 * A named entrypoint is reachable only through a service binding, never from
 * the internet: a chat can only come from our website's own code. Its input is
 * still re-checked, as WebErrors re-checks its reports.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "./bindings.js";
import { answerMarketingChat, type MarketingChatResult } from "./services/marketing-chat.js";

export class MarketingChat extends WorkerEntrypoint<Bindings> {
  /** Not an HTTP endpoint: a named entrypoint has no public route anyway. */
  async fetch(_request: Request): Promise<Response> {
    return new Response(null, { status: 404 });
  }

  /** One visitor message: `{ messages, ip }`, as the website sends it. */
  async reply(input: unknown): Promise<MarketingChatResult> {
    return answerMarketingChat(this.env, input);
  }
}
