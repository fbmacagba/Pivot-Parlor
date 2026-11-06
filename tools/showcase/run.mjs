#!/usr/bin/env node
/**
 * Showcase harness: runs the REAL site-generation pipeline locally for the two
 * fictional portfolio shops, then verifies the published output through the
 * public API before anything is captured.
 *
 *   node tools/showcase/run.mjs            build, migrate, seed, generate, verify, exit
 *   node tools/showcase/run.mjs --serve    ...then keep the API on :8787 for the web app
 *   node tools/showcase/run.mjs --serve --skip-build   reuse the last worker bundles
 *
 * What is real: the six production workers (API, booking, research, text,
 * images, assembler) bundled by wrangler from this checkout, the full
 * migration chain via scripts/migrate.mjs, owner setup through the public API
 * (settings, services, team, specialities, portrait uploads, AI settings),
 * POST /generate-site, the queues between the workers, the assembler's gate,
 * POST /activate, and the public read endpoints.
 *
 * What is replayed: the model. Every outbound request leaves the workers
 * through one handler. OpenRouter chat calls are answered from replay.mjs
 * (authored responses, see its header) and image calls with the files in
 * assets/ (provenance in assets/PROVENANCE.json). Every other outbound
 * request, including email and payment providers, is refused and logged, and
 * the log is part of the report. Nothing here touches a Cloudflare account,
 * production data or a paid API.
 */
import { Miniflare } from "miniflare";
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONTROL_SHOP, DEMO_SHOPS } from "./shops.mjs";
import { IMAGE_JOBS } from "./image-prompts.mjs";
import { RESEARCH, TEXT } from "./replay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");
const stateDir = path.join(here, ".state");
const persist = path.join(stateDir, "persist");
const bundles = path.join(stateDir, "bundles");
// Override only for harness development (e.g. a scratch copy of the assets).
const assetsDir = process.env.SHOWCASE_ASSETS ? path.resolve(process.env.SHOWCASE_ASSETS) : path.join(here, "assets");
const argv = new Set(process.argv.slice(2));

const PORT = 8787;
const BASE = `http://127.0.0.1:${PORT}`;
const WEB = "http://127.0.0.1:8788";
const D1_ID = "515a7270-81b4-4935-b106-15aeee639f57"; // local key only; never a remote binding
const KV_ID = "showcase-kv";
const JWT_SECRET = "showcase-local-only-jwt-secret-not-a-real-secret";
const REPLAY_KEY = "replay-no-network";

const WORKERS = [
  { name: "pivot-parlor-api", dir: "apps/worker", nodeCompat: true },
  { name: "pivot-parlor-booking", dir: "apps/workers/booking", nodeCompat: true },
  { name: "pivot-parlor-research", dir: "apps/workers/research" },
  { name: "pivot-parlor-text", dir: "apps/workers/text" },
  { name: "pivot-parlor-images", dir: "apps/workers/images" },
  { name: "pivot-parlor-assembler", dir: "apps/workers/builder" },
];

const log = (...a) => console.log("[showcase]", ...a);
const fail = (msg) => {
  throw new Error(msg);
};

// ── 1. Bundle the workers exactly as `wrangler deploy` would ────────────────
function buildBundles() {
  const wrangler = path.join(repo, "node_modules", "wrangler", "bin", "wrangler.js");
  for (const w of WORKERS) {
    const out = path.join(bundles, w.name);
    rmSync(out, { recursive: true, force: true });
    log(`bundling ${w.name}`);
    execFileSync(process.execPath, [wrangler, "deploy", "--dry-run", "--outdir", out], {
      cwd: path.join(repo, w.dir),
      stdio: ["ignore", "ignore", "inherit"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
  }
}

// ── 2. Fresh local database through the real migration runner ──────────────
function migrate() {
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  log("applying the migration chain (scripts/migrate.mjs)");
  const out = execFileSync(process.execPath, [path.join(repo, "scripts", "migrate.mjs"), "--persist-to", persist], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  const applied = /applied (\d+) migration/i.exec(out)?.[1];
  log(`migrations: ${applied ? `${applied} applied` : out.trim().split("\n").pop()}`);
}

// ── 3. The outbound boundary: replay the model, refuse everything else ─────
const outboundLog = [];
const assetBytes = (shop, name) => readFileSync(path.join(assetsDir, shop, `${name}.webp`));

function imageForPrompt(prompt) {
  const exact = IMAGE_JOBS.find(([, , , , p]) => prompt === p || prompt.startsWith(p));
  if (exact) return [exact[0], exact[1]];
  // Research builds catalog prompts deterministically from the service name.
  const svc = /^Photorealistic close-up of the finished (.+) result on /.exec(prompt)?.[1];
  for (const shop of DEMO_SHOPS) {
    const s = shop.services.find((x) => x.name === svc);
    if (s) return [shop.key, s.image];
  }
  return null;
}

function shopKeyFromPrompt(text) {
  const name = /Shop name: (.+)/.exec(text)?.[1]?.trim();
  return DEMO_SHOPS.find((s) => s.name === name)?.key ?? null;
}

const chatReply = (content) =>
  Response.json({
    choices: [{ message: { role: "assistant", content } }],
    usage: { prompt_tokens: 0, completion_tokens: 0 },
  });

function outbound(worker) {
  return async (request) => {
    const url = new URL(request.url);
    const title = request.headers.get("X-Title") ?? "";
    const entry = { worker, method: request.method, url: `${url.origin}${url.pathname}`, title };
    if (url.host === "openrouter.ai" && url.pathname === "/api/v1/chat/completions") {
      const body = await request.json();
      const userText = (body.messages ?? []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      if (title === "Pivot Parlor Research" || title === "Pivot Parlor Text") {
        const key = shopKeyFromPrompt(userText);
        if (key) {
          outboundLog.push({ ...entry, outcome: `replayed ${title.split(" ").pop().toLowerCase()} response (${key})` });
          return chatReply(JSON.stringify((title.endsWith("Research") ? RESEARCH : TEXT)[key]));
        }
      }
      if (title === "Pivot Parlor Images") {
        const prompt = body.messages?.[0]?.content?.[0]?.text ?? "";
        const hit = imageForPrompt(prompt);
        if (hit) {
          outboundLog.push({ ...entry, outcome: `replayed image ${hit[0]}/${hit[1]}.webp` });
          const b64 = assetBytes(hit[0], hit[1]).toString("base64");
          return Response.json({
            choices: [{ message: { role: "assistant", content: null, images: [{ type: "image_url", image_url: { url: `data:image/webp;base64,${b64}` } }] } }],
          });
        }
        outboundLog.push({ ...entry, outcome: "refused: no replay image for this prompt", prompt: prompt.slice(0, 120) });
        return new Response("harness: no replay image for this prompt (e.g. the logo)", { status: 503 });
      }
    }
    outboundLog.push({ ...entry, outcome: "refused: outbound network disabled in the harness" });
    return Response.json({ error: "outbound network disabled in the showcase harness" }, { status: 503 });
  };
}

// ── 4. Workers ──────────────────────────────────────────────────────────────
function startMiniflare() {
  const common = (w) => ({
    name: w.name,
    // Declared explicitly: wrangler's single-file bundles keep a dynamic
    // import() that Miniflare's module tracer refuses to follow.
    modules: [{ type: "ESModule", path: path.join(bundles, w.name, "index.js") }],
    compatibilityDate: "2025-06-01",
    compatibilityFlags: w.nodeCompat ? ["nodejs_compat"] : [],
    d1Databases: { DB: D1_ID },
    kvNamespaces: { KV: KV_ID },
    outboundService: outbound(w.name),
  });
  const consumer = (queue) => ({ [queue]: { maxBatchSize: 1, maxBatchTimeout: 1, maxRetries: 0 } });
  const [api, booking, research, text, images, assembler] = WORKERS;
  return new Miniflare({
    host: "127.0.0.1",
    port: PORT,
    d1Persist: path.join(persist, "v3", "d1"),
    kvPersist: path.join(persist, "v3", "kv"),
    r2Persist: path.join(persist, "v3", "r2"),
    workers: [
      {
        ...common(api),
        r2Buckets: { ASSETS: "pivot-parlor-assets" },
        queueProducers: { QUEUE: "pivot-parlor-reminders", site_research_queue: "site-research-queue" },
        serviceBindings: { BOOKING: booking.name },
        bindings: { ENVIRONMENT: "development", JWT_SECRET, ASSET_BASE_URL: BASE, APP_URL: WEB },
      },
      {
        ...common(booking),
        queueProducers: { QUEUE: "pivot-parlor-reminders" },
        bindings: { ENVIRONMENT: "development", JWT_SECRET, PLATFORM_URL: BASE, WEB_URL: WEB },
      },
      {
        ...common(research),
        queueConsumers: consumer("site-research-queue"),
        queueProducers: {
          SITE_IMAGES_QUEUE: "site-images-queue",
          SITE_TEXT_QUEUE: "site-text-queue",
          SITE_ASSEMBLE_QUEUE: "site-assemble-queue",
        },
        bindings: { ENVIRONMENT: "development", OPENROUTER_API_KEY: REPLAY_KEY },
      },
      {
        ...common(text),
        queueConsumers: consumer("site-text-queue"),
        queueProducers: { SITE_ASSEMBLE_QUEUE: "site-assemble-queue" },
        bindings: { ENVIRONMENT: "development", OPENROUTER_API_KEY: REPLAY_KEY },
      },
      {
        ...common(images),
        r2Buckets: { ASSETS: "pivot-parlor-assets" },
        queueConsumers: consumer("site-images-queue"),
        queueProducers: { SITE_ASSEMBLE_QUEUE: "site-assemble-queue" },
        bindings: { ENVIRONMENT: "development", OPENROUTER_API_KEY: REPLAY_KEY, ASSET_BASE_URL: BASE },
      },
      {
        ...common(assembler),
        queueConsumers: consumer("site-assemble-queue"),
        queueProducers: { SITE_ASSEMBLE_QUEUE: "site-assemble-queue" },
        bindings: { ENVIRONMENT: "development" },
      },
    ],
  });
}

// ── 5. Identity and API helpers ─────────────────────────────────────────────
const b64u = (s) => Buffer.from(s).toString("base64url");
function signJwt(payload) {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

let token = "";
async function api(method, p, body, { raw = false } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload });
  if (raw) return res;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${method} ${p} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

// ── 6. Seed: shop records only; everything an owner enters goes through the API
async function seed(mf) {
  const db = await mf.getD1Database("DB", "pivot-parlor-api");
  const kv = await mf.getKVNamespace("KV", "pivot-parlor-api");
  await db
    .prepare(
      "INSERT INTO platform_users (id, name, email, password_hash, role, email_verified) VALUES ('pp-local-dev', 'Local developer', 'dev@showcase.local.invalid', 'x', 'developer', 1)"
    )
    .run();
  token = signJwt({ sub: "pp-local-dev", role: "developer", exp: Math.floor(Date.now() / 1000) + 86400 });
  await kv.put(`session:${token}`, JSON.stringify({ user_id: "pp-local-dev", role: "developer", shop_id: null }));

  // Shop rows are provisioned directly, like the E2E fixture: the platform's
  // own create route always mints "<name>-<number>" slugs, which by design can
  // never produce a code-owned demo id or "-demo" slug.
  for (const s of [...DEMO_SHOPS, CONTROL_SHOP]) {
    await db
      .prepare(
        "INSERT INTO shops (id, shop_number, slug, name, type, owner_email, status) VALUES (?, ?, ?, ?, ?, ?, 'active')"
      )
      .bind(s.id, s.shopNumber, s.slug, s.name, s.type, s.ownerEmail)
      .run();
  }

  for (const shop of DEMO_SHOPS) {
    await api("PATCH", `/api/shops/${shop.id}/settings`, shop.settings);
    const serviceIds = new Map();
    for (const svc of shop.services) {
      const { data } = await api("POST", `/api/shops/${shop.id}/services`, {
        name: svc.name,
        category: svc.category,
        price_pence: svc.price_pence,
        duration_min: svc.duration_min,
      });
      serviceIds.set(svc.name, data.id);
    }
    for (const member of shop.staff) {
      const { data } = await api("POST", `/api/shops/${shop.id}/staff`, {
        display_name: member.name,
        email: member.email,
        service_ids: member.services.map((n) => serviceIds.get(n) ?? fail(`unknown service ${n}`)),
      });
      await api("PUT", `/api/shops/${shop.id}/staff/${data.id}`, { speciality: member.speciality });
      const form = new FormData();
      form.append("file", new File([assetBytes(shop.key, member.portrait)], `${member.portrait}.webp`, { type: "image/webp" }));
      await api("POST", `/api/shops/${shop.id}/staff/${data.id}/avatar`, form);
    }
    await api("POST", `/api/shops/${shop.id}/settings`, { design_notes: shop.designNotes, composer: "ai" });
    log(`seeded ${shop.name}: ${shop.services.length} services, ${shop.staff.length} team members`);
  }

  // The control tenant: an ordinary shop with a plain live site.
  const c = CONTROL_SHOP;
  await db
    .prepare("INSERT INTO services (id, shop_id, name, duration_min, price_pence, category, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)")
    .bind("pp-local-control-svc", c.id, c.service.name, c.service.duration_min, c.service.price_pence, c.service.category)
    .run();
  await db
    .prepare("INSERT INTO platform_users (id, name, email, password_hash, role, shop_id, email_verified) VALUES (?, ?, ?, 'x', 'staff', ?, 1)")
    .bind("pp-local-control-user", c.staffName, "sam@control.local.invalid", c.id)
    .run();
  await db
    .prepare("INSERT INTO staff (id, shop_id, user_id, display_name) VALUES (?, ?, ?, ?)")
    .bind("pp-local-control-staff", c.id, "pp-local-control-user", c.staffName)
    .run();
  await db
    .prepare(
      "INSERT INTO shop_sites (id, shop_id, template, headline, tagline, services_json, website_status) VALUES (?, ?, 'classic', ?, ?, ?, 'live')"
    )
    .bind(
      "pp-local-control-site",
      c.id,
      "Control Cuts",
      "Straightforward cuts in a neighbourhood shop.",
      JSON.stringify([{ name: c.service.name, price_gbp: c.service.price_pence / 100, duration_minutes: c.service.duration_min }])
    )
    .run();
  log("seeded the control tenant");
  return db;
}

// ── 7. Generate through the real pipeline ───────────────────────────────────
async function generate(db, shop) {
  const { data } = await api("POST", `/api/shops/${shop.id}/generate-site`, {});
  const jobId = data.jobId;
  log(`${shop.name}: job ${jobId} queued`);
  const deadline = Date.now() + 10 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const row = await db.prepare("SELECT status, stage, error FROM generation_jobs WHERE id = ?").bind(jobId).first();
    const now = `${row?.status}/${row?.stage}`;
    if (now !== last) log(`${shop.name}: ${now}`);
    last = now;
    if (row?.status === "complete") return jobId;
    if (row?.status === "failed") fail(`${shop.name}: generation failed: ${row.error}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  fail(`${shop.name}: generation timed out at ${last}`);
}

// ── 8. Verify the published output through the public API ───────────────────
const CLAIMS = /★|happy clients|award|guarantee|best (barber|salon)|top[\s-]rated|\d+\s*\+?\s*years|testimonial|—/i;

async function verify(db, shop) {
  const problems = [];
  const check = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  const site = (await api("GET", `/api/shops/${shop.slug}/site`)).data;
  const services = (await api("GET", `/api/shops/${shop.slug}/services`)).data;
  const staff = (await api("GET", `/api/shops/${shop.slug}/booking-staff`)).data;

  const fetchImage = async (u) => {
    if (!u) return 0;
    const r = await fetch(u);
    const len = (await r.arrayBuffer()).byteLength;
    return r.ok ? len : -r.status;
  };

  check(site.website_status === "live", `site not live: ${site.website_status}`);
  check(Number(site.design_version) === 3, `design_version ${site.design_version}`);
  check((await fetchImage(site.hero_image_url)) > 0, `hero image missing: ${site.hero_image_url}`);

  const gallery = site.gallery_images ?? [];
  check(gallery.length === 3, `gallery has ${gallery.length} images`);
  for (const g of gallery) check((await fetchImage(g)) > 0, `gallery image not served: ${g}`);

  const want = shop.services.map((s) => `${s.name}|${s.price_pence}|${s.duration_min}`).sort();
  const got = services.map((s) => `${s.name}|${s.price_pence}|${s.durationMinutes}`).sort();
  check(JSON.stringify(want) === JSON.stringify(got), `services differ: ${JSON.stringify(got)}`);
  for (const s of services) check(s.description?.length > 20, `no description for ${s.name}`);

  const published = Array.isArray(site.services) ? site.services : [];
  const siteMenu = published.map((s) => `${s.name}|${Math.round(s.price_gbp * 100)}|${s.duration_minutes}`).sort();
  check(JSON.stringify(siteMenu) === JSON.stringify(want), `site menu differs from the booking menu: ${JSON.stringify(siteMenu)}`);

  const catalog = Array.isArray(site.catalog_images) ? site.catalog_images : [];
  check(catalog.length === shop.services.length, `catalog has ${catalog.length} slots`);
  for (const u of catalog) check((await fetchImage(u)) > 0, `catalog image not served: ${u}`);

  check(staff.length === shop.staff.length, `booking-staff lists ${staff.length}`);
  for (const m of shop.staff) {
    const row = staff.find((x) => x.display_name === m.name);
    check(row?.speciality === m.speciality, `${m.name}: speciality ${row?.speciality}`);
    check((await fetchImage(row?.avatar_url)) > 0, `${m.name}: portrait not served (${row?.avatar_url})`);
  }

  const text = JSON.stringify({
    h: site.headline,
    t: site.tagline,
    a: site.about,
    s: site.trust_signals,
    u: site.usps,
    m: published.map((s) => s.description),
  });
  check(!CLAIMS.test(text), `published copy carries a claim or em-dash: ${CLAIMS.exec(text)?.[0]}`);
  check(!/Default service/.test(JSON.stringify(published)), "placeholder service published");

  return {
    shop: shop.name,
    url: `${WEB}/${shop.slug}`,
    headline: site.headline,
    design: { mood: site.layout_mood, spec: site.design_spec ?? null },
    services: services.length,
    staff: staff.length,
    gallery: gallery.length,
    catalog: catalog.filter(Boolean).length,
    logo: site.logo_url || "(none: the replay refuses the logo prompt, so the typeset name is used)",
    problems,
  };
}

// ── 9. Owner review: regenerating a LIVE site changes nothing until Publish ─
// Staging has no generation pipeline, so this is the end-to-end proof of
// assembler -> shop_site_candidates -> preview -> publish (migration 049).
async function reviewFlow(db, shop) {
  const problems = [];
  const check = (cond, msg) => {
    if (!cond) problems.push(msg);
  };
  const publicSite = async () => JSON.stringify((await api("GET", `/api/shops/${shop.slug}/site`)).data);
  const rowStamp = async () =>
    (await db.prepare("SELECT generated_at FROM shop_sites WHERE shop_id = ? AND status = 'active'").bind(shop.id).first())
      ?.generated_at ?? null;

  const siteBefore = await publicSite();
  const stampBefore = await rowStamp();

  const jobId = await generate(db, shop);
  const status = (await api("GET", `/api/jobs/${jobId}/status`)).data;
  check(status.outcome === "candidate", `job outcome is ${status.outcome}, expected candidate`);
  check(status.stage === "review", `job stage is ${status.stage}, expected review`);
  check((await publicSite()) === siteBefore, "the public site changed before Publish");
  check((await rowStamp()) === stampBefore, "the site row was rewritten before Publish");

  const preview = (await api("GET", `/api/shops/${shop.id}/site-candidate`)).data;
  check(preview.job_id === jobId, `pending version is job ${preview.job_id}, expected ${jobId}`);
  check(preview.services_unchanged === true, "pending version was made for a different menu");
  check(Array.isArray(preview.services) && preview.services.length === shop.services.length, "preview services missing");

  const stale = await api("POST", `/api/shops/${shop.id}/site-candidate/publish`, { job_id: "not-the-previewed-job" }, { raw: true });
  check(stale.status === 409, `publishing a version other than the previewed one returned ${stale.status}`);

  await api("POST", `/api/shops/${shop.id}/site-candidate/publish`, { job_id: jobId });
  const stampAfter = await rowStamp();
  check(Boolean(stampAfter) && stampAfter !== stampBefore, "Publish did not write the site row");
  const gone = await api("GET", `/api/shops/${shop.id}/site-candidate`, undefined, { raw: true });
  check(gone.status === 404, `pending version still present after Publish (${gone.status})`);

  const after = await verify(db, shop);
  problems.push(...after.problems.map((p) => `after Publish: ${p}`));
  return { shop: shop.name, jobId, stampBefore, stampAfter, problems };
}

async function writeCounts(db) {
  const out = {};
  for (const table of ["bookings", "waitlist", "walkin_queue"]) {
    const ids = [...DEMO_SHOPS.map((s) => s.id), CONTROL_SHOP.id];
    const rows = await db
      .prepare(`SELECT shop_id, COUNT(*) AS n FROM ${table} WHERE shop_id IN (${ids.map(() => "?").join(",")}) GROUP BY shop_id`)
      .bind(...ids)
      .all();
    out[table] = Object.fromEntries((rows.results ?? []).map((r) => [r.shop_id, r.n]));
  }
  return out;
}

async function probeDemoWrites(db) {
  const results = [];
  for (const shop of DEMO_SHOPS) {
    const svc = await db.prepare("SELECT id FROM services WHERE shop_id = ? LIMIT 1").bind(shop.id).first();
    const st = await db.prepare("SELECT id FROM staff WHERE shop_id = ? LIMIT 1").bind(shop.id).first();
    const attempts = [
      ["POST", "/api/bookings", { shop_id: shop.id, service_id: svc.id, staff_id: st.id, customer_name: "Probe", customer_email: "probe@example.invalid", date: "2099-06-16", start_time: "2099-06-16T10:00:00.000Z" }],
      ["POST", "/api/waitlist", { shop_slug: shop.slug, customer_name: "Probe", customer_email: "probe@example.invalid" }],
      ["POST", `/api/walkin/${shop.slug}/join`, { name: "Probe" }],
    ];
    for (const [method, p, body] of attempts) {
      const res = await fetch(`${BASE}${p}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      results.push({ shop: shop.slug, request: `${method} ${p}`, status: res.status });
    }
  }
  return results;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  mkdirSync(stateDir, { recursive: true });
  for (const [shop, name] of IMAGE_JOBS) {
    if (!existsSync(path.join(assetsDir, shop, `${name}.webp`))) fail(`missing asset ${shop}/${name}.webp`);
  }
  if (!argv.has("--skip-build") || !existsSync(path.join(bundles, WORKERS[0].name, "index.js"))) buildBundles();
  migrate();
  const mf = startMiniflare();
  await mf.ready;
  log(`workers up on ${BASE}`);
  const db = await seed(mf);

  const report = { startedAt: new Date().toISOString(), shops: [], probes: [], counts: {}, outbound: outboundLog };
  for (const shop of DEMO_SHOPS) {
    const jobId = await generate(db, shop);
    await api("POST", `/api/shops/${shop.id}/activate`);
    const v = await verify(db, shop);
    report.shops.push({ ...v, jobId });
    log(`${shop.name}: ${v.problems.length === 0 ? "verified" : `PROBLEMS: ${v.problems.join("; ")}`}`);
  }
  report.review = await reviewFlow(db, DEMO_SHOPS[0]);
  log(
    `${report.review.shop} regenerated while live: ${
      report.review.problems.length === 0 ? "held for review, then published" : `PROBLEMS: ${report.review.problems.join("; ")}`
    }`
  );
  report.counts.beforeProbes = await writeCounts(db);
  report.probes = await probeDemoWrites(db);
  report.counts.afterProbes = await writeCounts(db);
  report.control = await db.prepare("SELECT website_status, headline FROM shop_sites WHERE shop_id = ?").bind(CONTROL_SHOP.id).first();

  const refused = outboundLog.filter((e) => e.outcome.startsWith("refused"));
  report.summary = {
    verified: report.shops.every((s) => s.problems.length === 0),
    reviewHeld: report.review.problems.length === 0,
    probesRefused: report.probes.every((p) => p.status === 403),
    noDemoRows: JSON.stringify(report.counts.afterProbes) === JSON.stringify({ bookings: {}, waitlist: {}, walkin_queue: {} }),
    refusedOutbound: refused.map((e) => `${e.worker} ${e.method} ${e.url} (${e.outcome})`),
  };
  writeFileSync(path.join(stateDir, "report.json"), JSON.stringify(report, null, 2));
  log("report:", path.join(stateDir, "report.json"));
  log(JSON.stringify(report.summary, null, 2));

  if (argv.has("--serve")) {
    // For looking at the review step in the browser: leave the salon's next
    // version pending, and hand over this local developer session (signed
    // with the harness's fake secret, valid only against this local API).
    if (argv.has("--pending-review")) {
      const pendingJob = await generate(db, DEMO_SHOPS[1]);
      log(`${DEMO_SHOPS[1].name}: new version ${pendingJob} left waiting for review`);
    }
    writeFileSync(path.join(stateDir, "dev-session.txt"), token);
    log(`local developer session: .state/dev-session.txt (set it as the pp_session cookie on ${WEB})`);
    log(`serving the API on ${BASE}. Start the web app with:`);
    log(`  cd apps/web && npm run build && npx wrangler pages dev ./build/client --port 8788 --binding API_URL=${BASE}`);
    log(`then open ${WEB}/${DEMO_SHOPS[0].slug} and ${WEB}/${DEMO_SHOPS[1].slug}`);
    process.on("SIGINT", async () => {
      writeFileSync(path.join(stateDir, "outbound.json"), JSON.stringify(outboundLog, null, 2));
      await mf.dispose();
      process.exit(0);
    });
    setInterval(() => writeFileSync(path.join(stateDir, "outbound.json"), JSON.stringify(outboundLog, null, 2)), 5000);
  } else {
    await mf.dispose();
    if (!report.summary.verified || !report.summary.reviewHeld || !report.summary.probesRefused || !report.summary.noDemoRows) {
      process.exit(1);
    }
  }
}

main().catch((e) => {
  console.error("[showcase] FAILED:", e.message);
  process.exit(1);
});
