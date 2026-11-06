#!/usr/bin/env node
/**
 * Provision the two FICTIONAL portfolio demo shops in a real environment,
 * through the platform's own API, the way an owner would set them up.
 *
 * Run by the operator, in three deliberate steps (each one is a separate run):
 *
 *   1. node tools/showcase/provision.mjs              owner setup (no cost)
 *   2. node tools/showcase/provision.mjs --generate   PAID: one generation per shop
 *   3. node tools/showcase/provision.mjs --activate   publish both shops
 *
 * Before step 1, insert the two shop rows (tools/showcase/provision-prod.sql):
 *   cd apps/worker && npx wrangler d1 execute pivot-parlor-db --remote \
 *     --file ../../tools/showcase/provision-prod.sql
 *
 * Sign-in: DEV_PASSWORD (required) and DEV_EMAIL (default dev@pivotparlor.com)
 * come from the environment, e.g. `node --env-file=.env tools/showcase/provision.mjs`.
 * The session lives only in this process and is revoked at the end of the run.
 * PROVISION_TOKEN instead reuses an existing developer session (for the local
 * harness, whose session is in .state/dev-session.txt). API base: --api <url>, default
 * https://api.pivotparlor.com. Limit to one shop with --shop ferdyms|linden.
 *
 * Owner setup is idempotent: it creates only the services and team members
 * that are missing, so a re-run after a partial failure resumes instead of
 * duplicating. Every step prints what it did; any error stops the run.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_SHOPS } from "./shops.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const API = option("--api", "https://api.pivotparlor.com").replace(/\/+$/, "");
const ONLY = option("--shop", "");
const MODE = flag("--generate") ? "generate" : flag("--activate") ? "activate" : "setup";
const shops = DEMO_SHOPS.filter((s) => !ONLY || s.key === ONLY);
if (shops.length === 0) throw new Error(`--shop must be one of: ${DEMO_SHOPS.map((s) => s.key).join(", ")}`);

const log = (...a) => console.log("[provision]", ...a);
let token = "";

async function api(method, p, body, { auth = true, allow = [] } = {}) {
  const headers = auth ? { Authorization: `Bearer ${token}` } : {};
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${API}${p}`, { method, headers, body: payload });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !allow.includes(res.status)) {
    throw new Error(`${method} ${p} -> ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { status: res.status, json };
}

let ownSession = false;
async function signIn() {
  // PROVISION_TOKEN: an existing developer session (the local harness writes
  // one to .state/dev-session.txt). Otherwise sign in with DEV_PASSWORD.
  if (process.env.PROVISION_TOKEN) {
    token = process.env.PROVISION_TOKEN.trim();
  } else {
    const password = process.env.DEV_PASSWORD;
    if (!password) throw new Error("DEV_PASSWORD is not set. Run with --env-file=<path to .env> or set it in the shell.");
    const email = process.env.DEV_EMAIL || "dev@pivotparlor.com";
    const { json } = await api("POST", "/auth/login", { email, password }, { auth: false });
    if (!json?.data?.token) throw new Error("sign-in returned no session");
    token = json.data.token;
    ownSession = true;
  }
  const { json: me } = await api("GET", "/auth/me");
  if (me?.data?.role !== "developer") throw new Error(`this session is not a developer (${me?.data?.role})`);
  log(`signed in to ${API} as a developer`);
}

/** Revoke a session this run created, so no token outlives the run. */
async function signOut() {
  if (ownSession) await api("POST", "/auth/logout").catch((e) => log(`sign-out failed: ${e.message}`));
}

/** The shop row must exist and be the fictional backing shop, never a real tenant. */
async function requireShop(shop) {
  const { status, json } = await api("GET", `/api/shops/${shop.id}`, undefined, { auth: false, allow: [404] });
  if (status === 404) throw new Error(`${shop.name}: no shop row yet. Run provision-prod.sql first.`);
  const row = json.data;
  if (row?.id !== shop.id || row?.slug !== shop.slug) {
    throw new Error(`${shop.name}: /api/shops/${shop.id} returned id=${row?.id} slug=${row?.slug}; refusing to touch it`);
  }
}

const publicList = async (shop, what) => (await api("GET", `/api/shops/${shop.id}/${what}`, undefined, { auth: false })).json.data ?? [];

async function setup(shop) {
  await requireShop(shop);
  await api("PATCH", `/api/shops/${shop.id}/settings`, shop.settings);
  log(`${shop.name}: settings (address, phone, hours)`);

  const haveServices = new Map((await publicList(shop, "services")).map((s) => [s.name, s.id]));
  for (const svc of shop.services) {
    if (haveServices.has(svc.name)) continue;
    const { json } = await api("POST", `/api/shops/${shop.id}/services`, {
      name: svc.name,
      category: svc.category,
      price_pence: svc.price_pence,
      duration_min: svc.duration_min,
    });
    haveServices.set(svc.name, json.data.id);
    log(`${shop.name}: service ${svc.name}`);
  }

  // A member is complete only with their speciality and portrait, so a re-run
  // after a failure part-way through a member finishes that member too.
  const haveStaff = new Map((await publicList(shop, "booking-staff")).map((m) => [m.display_name, m]));
  for (const member of shop.staff) {
    const row = haveStaff.get(member.name);
    let staffId = row?.id;
    if (!row) {
      const serviceIds = member.services.map((n) => haveServices.get(n) ?? (() => { throw new Error(`unknown service ${n}`); })());
      const { status, json } = await api(
        "POST",
        `/api/shops/${shop.id}/staff`,
        { display_name: member.name, email: member.email, service_ids: serviceIds },
        { allow: [409] }
      );
      if (status === 409) {
        throw new Error(`${shop.name}: ${member.name} (${member.email}) exists but is not bookable (deactivated?). Reactivate them on the shop's Staff page, then run again.`);
      }
      staffId = json.data.id;
      log(`${shop.name}: team member ${member.name}`);
    }
    if ((row?.speciality ?? "") !== member.speciality) {
      await api("PUT", `/api/shops/${shop.id}/staff/${staffId}`, { speciality: member.speciality });
      log(`${shop.name}: ${member.name}: speciality`);
    }
    if (!row?.avatar_url) {
      const bytes = readFileSync(path.join(here, "assets", shop.key, `${member.portrait}.webp`));
      const form = new FormData();
      form.append("file", new File([bytes], `${member.portrait}.webp`, { type: "image/webp" }));
      await api("POST", `/api/shops/${shop.id}/staff/${staffId}/avatar`, form);
      log(`${shop.name}: ${member.name}: portrait`);
    }
  }

  await api("POST", `/api/shops/${shop.id}/settings`, { design_notes: shop.designNotes, composer: "ai" });
  const services = await publicList(shop, "services");
  const staff = await publicList(shop, "booking-staff");
  const complete = staff.filter((m) => shop.staff.some((s) => s.name === m.display_name && s.speciality === m.speciality) && m.avatar_url);
  const ok = services.length === shop.services.length && complete.length === shop.staff.length;
  log(`${shop.name}: ${ok ? "ready" : "INCOMPLETE"}. ${services.length}/${shop.services.length} services, ${complete.length}/${shop.staff.length} team members with speciality and portrait`);
  if (!ok) throw new Error(`${shop.name}: setup did not complete; run again`);
}

async function generate(shop) {
  await requireShop(shop);
  const services = await publicList(shop, "services");
  if (services.length < shop.services.length) throw new Error(`${shop.name}: setup incomplete (${services.length} services); run setup first`);
  const { json } = await api("POST", `/api/shops/${shop.id}/generate-site`, {});
  const jobId = json?.data?.jobId;
  if (!jobId) throw new Error(`${shop.name}: generate-site returned no job id: ${JSON.stringify(json).slice(0, 200)}`);
  log(`${shop.name}: generation job ${jobId} started (paid model calls)`);
  const deadline = Date.now() + 25 * 60_000;
  let last = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10_000));
    const { json: s } = await api("GET", `/api/jobs/${jobId}/status`);
    const d = s?.data ?? {};
    const now = `${d.status}/${d.stage}`;
    if (now !== last) log(`${shop.name}: ${now}`);
    last = now;
    if (d.status === "complete") {
      return log(
        d.outcome === "candidate"
          ? `${shop.name}: done. The site is live, so the new version is waiting for review: publish or discard it on /dev/shops/${shop.id}.`
          : `${shop.name}: done, written to the draft. Nothing is public until --activate.`
      );
    }
    if (d.status === "failed") throw new Error(`${shop.name}: generation failed: ${d.error}`);
  }
  throw new Error(`${shop.name}: still ${last} after 25 minutes; check the dev shop page`);
}

async function activate(shop) {
  await requireShop(shop);
  await api("POST", `/api/shops/${shop.id}/activate`);
  const site = (await api("GET", `/api/shops/${shop.id}/site`, undefined, { auth: false })).json.data;
  log(`${shop.name}: website_status=${site?.website_status}`);
}

await signIn();
try {
  for (const shop of shops) {
    if (MODE === "setup") await setup(shop);
    else if (MODE === "generate") await generate(shop);
    else await activate(shop);
  }
  log(`${MODE} finished for ${shops.map((s) => s.name).join(" and ")}`);
} finally {
  await signOut();
}
