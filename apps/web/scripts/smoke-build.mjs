// Serves the production build under the Cloudflare runtime (`wrangler pages dev`,
// which runs workerd with functions/_middleware.ts and build/server) and GETs a
// few pages. Exits 1 on any failure, including a server that never starts.
//
// Why: `npm run build` can succeed while the bundle it writes cannot render in
// workerd. On 2026-11-14 the React Router 7 build resolved React's Node server
// renderer, and every page answered 500 ("renderToReadableStream is not a
// function") with the build, the type check and every unit test green.
//
// Usage (from apps/web, after `npm run build`):
//   node scripts/smoke-build.mjs [dir]
// dir is what gets deployed: ./build/client (the default, wrangler.toml's
// pages_build_output_dir) or ./.pages-dist (deploy-web.yml).
// GETs, plus POSTs with no session: a sign-in form posted without JavaScript
// (missing fields, so it never calls the API), one sign-out, and cross-site posts
// refused before any action runs. API calls go to the API service binding, which
// is not connected locally, so nothing here reaches a real API.
import { spawn, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import process from "node:process";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.argv[2] ?? "./build/client";
const PORT = 8798;
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 120_000;

// Each page: the status it must answer with. Every one must be HTML with an
// <h1>, carry a Content-Security-Policy nonce, and put that nonce on every
// <script> it writes (the CSP is enforced, so a script without it never runs).
const PAGES = [
  { path: "/", status: 200 },
  { path: "/pricing", status: 200 },
  { path: "/login", status: 200 },
  { path: "/no-such-page-smoke", status: 404 },
];

// [path, Origin]: a page's document post, a data post, a data post from a
// context browsers label "null" (a sandboxed frame, say), and a document post
// to an action with no page (React Router 7 checks pages only).
const CROSS_SITE_POSTS = [
  ["/login", "https://elsewhere.example"],
  ["/login.data", "https://elsewhere.example"],
  ["/login.data", "null"],
  ["/logout", "https://elsewhere.example"],
];
const LOG_SETTLE_MS = 1500;

const require = createRequire(join(WEB, "package.json"));
const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin", "wrangler.js");

if (!existsSync(join(WEB, DIR)) || !existsSync(join(WEB, "build", "server", "index.js"))) {
  console.error(`smoke-build: no build to serve (${DIR}, build/server/index.js). Run \`npm run build\` first.`);
  process.exit(1);
}

const failures = [];
const fail = (msg) => failures.push(msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(
  process.execPath,
  [wrangler, "pages", "dev", DIR, "--port", String(PORT), "--ip", "127.0.0.1", "--show-interactive-dev-session=false"],
  {
    cwd: WEB,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
  }
);
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
let exited = false;
server.on("exit", () => (exited = true));

function stop() {
  if (exited) return;
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/T", "/F", "/PID", String(server.pid)], { stdio: "ignore" });
    else process.kill(-server.pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

async function waitReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`${BASE}/favicon.ico`);
      await r.arrayBuffer();
      return true;
    } catch {
      await sleep(1000);
    }
  }
  return false;
}

try {
  if (!(await waitReady())) {
    fail(exited ? "wrangler pages dev exited before it served anything" : `server not ready after ${READY_TIMEOUT_MS / 1000}s`);
  } else {
    for (const { path, status } of PAGES) {
      const res = await fetch(BASE + path, { redirect: "manual" });
      const body = await res.text();
      const where = `GET ${path}`;
      if (res.status !== status) fail(`${where}: status ${res.status}, expected ${status}`);
      if (!/^text\/html/.test(res.headers.get("content-type") ?? "")) fail(`${where}: content-type ${res.headers.get("content-type")}`);
      if (!/<h1[\s>]/.test(body)) fail(`${where}: no <h1> in the page`);
      const nonce = (res.headers.get("content-security-policy") ?? "").match(/'nonce-([^']+)'/)?.[1];
      const scripts = [...body.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
      if (!nonce) fail(`${where}: no CSP nonce in the Content-Security-Policy header`);
      else if (scripts.length === 0) fail(`${where}: no <script> tags (the page cannot hydrate)`);
      else {
        const missing = scripts.filter((t) => !t.includes(`nonce="${nonce}"`)).length;
        if (missing) fail(`${where}: ${missing} of ${scripts.length} <script> tags lack the header's nonce`);
      }
    }
    // A static file in a dot folder, served before the router (RFC 9116).
    const securityTxt = await fetch(`${BASE}/.well-known/security.txt`);
    const securityBody = await securityTxt.text();
    if (securityTxt.status !== 200) fail(`GET /.well-known/security.txt: status ${securityTxt.status}, expected 200`);
    if (!/^text\/plain/.test(securityTxt.headers.get("content-type") ?? "")) fail(`GET /.well-known/security.txt: content-type ${securityTxt.headers.get("content-type")}`);
    if (!/^Contact: https:\/\/pivotparlor\.com\/contact$/m.test(securityBody)) fail("GET /.well-known/security.txt: no Contact line for the contact page");

    // Single fetch: the router's data requests (`<path>.data`) answer as turbo-stream.
    const data = await fetch(`${BASE}/_root.data`);
    await data.text();
    if (data.status !== 200) fail(`GET /_root.data: status ${data.status}, expected 200`);
    if (!/^text\/x-script/.test(data.headers.get("content-type") ?? "")) fail(`GET /_root.data: content-type ${data.headers.get("content-type")}`);

    // Signing out the way <Form action="/logout"> does: the router's own data
    // request. Its redirect must still carry the cookies that clear the session,
    // through functions/_middleware.ts, which rebuilds every response. With no
    // session the action calls no API. wrangler.toml's APP_DOMAIN makes it two
    // cookies: the host-only one and the .pivotparlor.com one.
    const logout = await fetch(`${BASE}/logout.data`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
      body: "",
      redirect: "manual",
    });
    await logout.text();
    const cleared = logout.headers.getSetCookie().filter((c) => /^pp_session=;/.test(c) && /Max-Age=0/i.test(c));
    if (logout.status !== 202) fail(`POST /logout.data: status ${logout.status}, expected 202 (a data request's redirect)`);
    if (cleared.length !== 2) fail(`POST /logout.data: ${cleared.length} cookies clear pp_session, expected 2`);

    // A plain fetch() to a resource route still gets JSON: pages poll this one
    // and read JSON. With no session it refuses before calling the API.
    const job = await fetch(`${BASE}/api/jobs/e2e-job/status`, { redirect: "manual" });
    const jobBody = await job.text();
    const jobWhere = "GET /api/jobs/e2e-job/status";
    if (job.status !== 401) fail(`${jobWhere}: status ${job.status}, expected 401`);
    if (!/^application\/json/.test(job.headers.get("content-type") ?? "")) fail(`${jobWhere}: content-type ${job.headers.get("content-type")}`);
    if (job.headers.get("cache-control") !== "no-store") fail(`${jobWhere}: cache-control ${job.headers.get("cache-control")}, expected no-store`);
    if (jobBody !== JSON.stringify({ success: false, error: "Unauthorized" })) fail(`${jobWhere}: body ${jobBody.slice(0, 120)}`);

    // A form posted without JavaScript (a document post, no `.data`): the page
    // renders with the action's status and message. The action's answer is
    // also serialized into the hydration script, so only the rendered markup
    // counts.
    const noJs = await fetch(`${BASE}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: BASE },
      body: "",
      redirect: "manual",
    });
    const noJsHtml = await noJs.text();
    const noJsWhere = "POST /login without JavaScript";
    if (noJs.status !== 400) fail(`${noJsWhere}: status ${noJs.status}, expected 400`);
    if (!/^text\/html/.test(noJs.headers.get("content-type") ?? "")) fail(`${noJsWhere}: content-type ${noJs.headers.get("content-type")}`);
    if (!noJsHtml.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "").includes("Email and password are required.")) {
      fail(`${noJsWhere}: the page does not show the action's message`);
    }

    // Posts whose Origin names another site, or "null". functions/_middleware.ts
    // refuses them with a 403 before any route runs: React Router 7 checks
    // pages only, so a cross-site post to /logout used to sign the visitor out.
    // No action may run (no cookie is cleared), and the refusal is the site
    // defending itself, not a bug, so it must not be reported: a report is
    // logged first, and the error-line check below fails on it. The sign-out
    // above is the same-site control.
    for (const [path, origin] of CROSS_SITE_POSTS) {
      const res = await fetch(BASE + path, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
        body: "",
        redirect: "manual",
      });
      await res.text();
      const where = `POST ${path} with Origin ${origin}`;
      if (res.status !== 403) fail(`${where}: status ${res.status}, expected 403 (refused as cross-site)`);
      if (res.headers.getSetCookie().some((c) => /^pp_session=/.test(c))) fail(`${where}: set pp_session, so an action ran`);
    }
    // The runtime writes its log after the response; read it only once it has.
    await sleep(LOG_SETTLE_MS);
  }
} catch (err) {
  fail(`request failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  stop();
}

// Anything the runtime logged as an error fails the smoke, even on a 200.
// eslint-disable-next-line no-control-regex -- strips the terminal colour codes wrangler writes
const plain = log.replace(/\x1b\[[0-9;]*m/g, "");
const errorLines = plain.split("\n").filter((l) => /\[ERROR\]|Uncaught|is not a function/.test(l));
for (const line of errorLines.slice(0, 10)) fail(`server: ${line.trim()}`);

if (failures.length) {
  console.error(`smoke-build: FAILED (${failures.length})\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(
  `smoke-build: OK (${PAGES.length} pages, /_root.data, resource-route JSON, a no-JS form post, a sign-out and ${CROSS_SITE_POSTS.length} cross-site posts under wrangler pages dev, ${DIR})`
);
process.exit(0);
