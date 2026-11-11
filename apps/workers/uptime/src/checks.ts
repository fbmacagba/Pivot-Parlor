/**
 * Production uptime checks: read-only GETs against the public site and API,
 * the way a visitor would make them. Each check resolves to null (healthy)
 * or a short reason. Reasons never carry response bodies: they end up in
 * logs and alert emails.
 */

export interface UptimeEnv {
  SITE_ORIGIN: string;
  API_ORIGIN: string;
  /** A shop whose page, services and slots are always public (the FerdyM demo). */
  DEMO_SHOP_SLUG: string;
  /** "true" adds a check built to fail: the deploy-time firing control. Never set in wrangler.toml. */
  CONTROL_FAIL?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface Check {
  name: string;
  run: (get: (url: string, accept: string) => Promise<Response>) => Promise<string | null>;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  attempts: number;
  ms: number;
}

export interface RunOptions {
  attempts?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  now?: Date;
  sleep?: (ms: number) => Promise<void>;
}

const USER_AGENT = "pivot-parlor-uptime/1";
const HTML = "text/html";
const JSON_TYPE = "application/json";

function wantStatus(res: Response, want: number): string | null {
  return res.status === want ? null : `HTTP ${res.status} (want ${want})`;
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

/** A page a visitor loads: 200 HTML, optionally carrying our CSP (proof the app answered, not a static fallback). */
async function page(res: Response, needCsp: boolean): Promise<string | null> {
  try {
    const bad = wantStatus(res, 200);
    if (bad) return bad;
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes(HTML)) return `not HTML (content-type ${type || "missing"})`;
    if (needCsp && !res.headers.get("content-security-policy")) return "no Content-Security-Policy header";
    return null;
  } finally {
    await discard(res);
  }
}

async function readJson(res: Response): Promise<{ success?: unknown; data?: unknown } | null> {
  try {
    return (await res.json()) as { success?: unknown; data?: unknown };
  } catch {
    return null;
  }
}

/** One step of a JSON chain: 200 with { success: true }; returns the data or a reason. */
async function apiData(label: string, res: Response): Promise<{ data: unknown } | { fail: string }> {
  const bad = wantStatus(res, 200);
  if (bad) {
    await discard(res);
    return { fail: `${label}: ${bad}` };
  }
  const body = await readJson(res);
  if (!body || body.success !== true) return { fail: `${label}: not a JSON success` };
  return { data: body.data };
}

function tomorrowUtc(now: Date): string {
  return new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10);
}

export function buildChecks(env: UptimeEnv, now: Date): Check[] {
  const site = env.SITE_ORIGIN.replace(/\/+$/, "");
  const api = env.API_ORIGIN.replace(/\/+$/, "");
  const slug = encodeURIComponent(env.DEMO_SHOP_SLUG);

  const checks: Check[] = [
    { name: "site-home", run: async (get) => page(await get(`${site}/`, HTML), true) },
    { name: "site-login", run: async (get) => page(await get(`${site}/login`, HTML), false) },
    // Server-rendered from the API and D1.
    { name: "site-shop", run: async (get) => page(await get(`${site}/${slug}`, HTML), false) },
    {
      // The API worker is up and answering as itself: a JSON 401 refusal.
      name: "api-auth",
      run: async (get) => {
        const res = await get(`${api}/auth/me`, JSON_TYPE);
        const bad = wantStatus(res, 401);
        if (bad) {
          await discard(res);
          return bad;
        }
        const body = await readJson(res);
        return body && body.success === false ? null : "401 without the JSON refusal";
      },
    },
    {
      // API -> BOOKING service binding -> booking worker -> D1/KV.
      name: "booking-slots",
      run: async (get) => {
        const shop = await apiData("shop", await get(`${api}/api/shops/${slug}`, JSON_TYPE));
        if ("fail" in shop) return shop.fail;
        const shopId = (shop.data as { id?: unknown } | null)?.id;
        if (typeof shopId !== "string" || !shopId) return "shop: no id";
        const id = encodeURIComponent(shopId);

        const services = await apiData("services", await get(`${api}/api/shops/${id}/services`, JSON_TYPE));
        if ("fail" in services) return services.fail;
        const serviceId = Array.isArray(services.data) ? (services.data[0] as { id?: unknown } | undefined)?.id : undefined;
        if (typeof serviceId !== "string" || !serviceId) return "services: no services";

        const query = `date=${tomorrowUtc(now)}&service_id=${encodeURIComponent(serviceId)}`;
        const slots = await apiData("slots", await get(`${api}/api/shops/${id}/slots?${query}`, JSON_TYPE));
        if ("fail" in slots) return slots.fail;
        // An empty list is a closed day, not an outage.
        return Array.isArray(slots.data) ? null : "slots: data is not a list";
      },
    },
  ];

  if (env.CONTROL_FAIL === "true") {
    // Asks a page that does not exist to answer 200: fails on a healthy site.
    checks.push({
      name: "control-deliberate-failure",
      run: async (get) => page(await get(`${site}/no-such-shop-zzz-999`, HTML), false),
    });
  }
  return checks;
}

function reasonFor(err: unknown): string {
  const name = err instanceof Error || err instanceof DOMException ? err.name : typeof err;
  return name === "TimeoutError" ? "timed out" : `network error (${name})`;
}

export async function runCheck(check: Check, fetcher: Fetcher, opts: RunOptions = {}): Promise<CheckResult> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const get = (url: string, accept: string) =>
    fetcher(url, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept },
      signal: AbortSignal.timeout(timeoutMs),
    });

  const started = Date.now();
  let detail = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const reason = await check.run(get);
      if (reason === null) return { name: check.name, ok: true, detail: "ok", attempts: attempt, ms: Date.now() - started };
      detail = reason;
    } catch (err) {
      detail = reasonFor(err);
    }
    if (attempt < attempts) await sleep(opts.retryDelayMs ?? 5_000);
  }
  return { name: check.name, ok: false, detail, attempts, ms: Date.now() - started };
}

export async function runAll(env: UptimeEnv, fetcher: Fetcher, opts: RunOptions = {}): Promise<CheckResult[]> {
  const checks = buildChecks(env, opts.now ?? new Date());
  return Promise.all(checks.map((check) => runCheck(check, fetcher, opts)));
}
