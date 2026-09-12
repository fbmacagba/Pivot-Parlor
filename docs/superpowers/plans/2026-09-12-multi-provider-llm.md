# Multi-Provider LLM Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the developer pick, everywhere a model picker exists (site generation, AI Deploy theme generation) and for the customer chatbot, between OpenRouter, the OpenAI API called directly, and the Anthropic API called directly, with the top four tiers of each vendor discovered live and priced from OpenRouter's public feed.

**Architecture:** One dependency-free workspace package, `@repo/llm`, owns the three HTTP adapters (OpenRouter, OpenAI, Anthropic) behind a single `chatComplete()` plus route-qualified model ids (`openai-api/<model>`, `anthropic-api/<model>`, OpenRouter slugs unchanged). The API worker's model registry is rewritten to rank three live vendor lists by rule, price them from OpenRouter's feed, and cache the result in KV; validation, the theme generator and the three background workers all read the registry or call the shared client. The research, text and chatbot workers become npm workspaces (the booking worker is the precedent) so they can import `@repo/llm`. The web picker gains a Provider level, the shop page switches to live models, and AI Deploy gets a platform-wide chatbot model card backed by two small endpoints.

**Tech Stack:** TypeScript 5.9 strict; Cloudflare Workers (Hono 4, wrangler 4, `@cloudflare/vitest-pool-workers` for the API worker tests); plain vitest 4 (node) for `packages/llm` and the chatbot worker; Remix 2 on Cloudflare Pages with React 18.3 and vitest + jsdom for `apps/web`; Turborepo + npm workspaces.

**Spec:** `docs/superpowers/specs/2026-09-12-multi-provider-llm-design.md` (approved 2026-09-12). The plan argues from it; executors read both.

## Global Constraints

Every task's requirements implicitly include these:

- **Ids are opaque strings, route-qualified by prefix** (spec 3.1): `openai-api/<vendor model id>`, `anthropic-api/<vendor model id>`, anything else is an OpenRouter slug used verbatim. Stored settings, queue payloads and `shops.ai_model` keep their shape; no migration.
- **Keys are platform keys**: worker secrets `OPENROUTER_API_KEY` (exists), `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`. Never read a key from a request. A missing key hides that direct group from the registry and makes `chatComplete` throw `LlmError` with message `<route>: API key not configured`.
- **Defaults are unchanged and always listed**: text `google/gemini-3.1-flash-lite-preview`, image `google/gemini-3.1-flash-image`, theme `anthropic/claude-sonnet-5` (also the only `recommended` model). Image generation stays OpenRouter-only (`openrouter-image-generation.ts` and the images worker are not touched).
- **Validation error text is unchanged**: `Unknown text model: <id>` and `Unknown image model: <id>` with HTTP 400; stored ids that are no longer listed degrade to the pipeline default with a `console.warn`, never a 400.
- **Vendor API facts (spec section 2)**: OpenRouter feed `GET https://openrouter.ai/api/v1/models` (public, prices per token as strings, `supported_parameters`, `architecture.output_modalities`); OpenAI `GET https://api.openai.com/v1/models` (ids only); Anthropic `GET https://api.anthropic.com/v1/models?limit=1000` with header `anthropic-version: 2023-06-01` (ids, `display_name`, `capabilities.effort`). Neither vendor list carries prices. Chat endpoints: OpenRouter `POST https://openrouter.ai/api/v1/chat/completions`, OpenAI `POST https://api.openai.com/v1/chat/completions` (`max_completion_tokens`, `reasoning_effort`), Anthropic `POST https://api.anthropic.com/v1/messages` (`x-api-key`, `anthropic-version: 2023-06-01`, `output_config: { effort }`).
- **Effort levels are exactly `low | medium | high`**; Anthropic's `max`/`xhigh` are dropped.
- **KV keys**: registry cache `ai:models:v3` (TTL 3600 s), last good build `ai:models:v3:last` (no expiry), chatbot choice `platform:chatbot:model` = `{ "model_id": string, "updated_at": ISO string }`. The old key `ai:models:openrouter:v2` is simply abandoned.
- **Background workers deploy by hand, never via CI** (research, text, chatbot). Do not add them to any deploy workflow. `CI` (`.github/workflows/ci.yml`) runs `npm ci`, `npm run check-types`, `npm run lint`, `npm test`, `npm run build` at the root; new workspaces are covered automatically because Turbo runs every workspace that has the script.
- **No em-dashes in user-facing text** (CLAUDE.md). Use commas or full stops in labels and captions.
- **TypeScript is strict with `noUncheckedIndexedAccess: true`** in every package that extends `@repo/typescript-config/base.json` (the API worker and the new `packages/llm`): guard every indexed read (`arr[0]` is `T | undefined`, regex groups `m[1]` need `!` or a guard).
- **Module imports inside `apps/worker/src` use the `.js` suffix** (`./model-registry.js`); `apps/workers/*` use `.js` too; `packages/*` and `apps/web` use extensionless imports. Copy the style of the file you are in.
- **Test conventions**: API worker tests dispatch through `test/request.ts` (`dispatch(method, path, { headers, body })`) and mint tokens with `test/helpers.ts` (`seedShop`, `seedUser(role, shopId)`, `tokenFor`, `authHeaders`). Outbound HTTP in worker tests is intercepted by replacing `globalThis.fetch` (pattern in `apps/worker/test/ai-models.test.ts`); a stub that must fail throws synchronously inside the stub, never returns `Promise.reject()` (workerd's unhandled-rejection detector). Web client-render tests use `createRoot` + `act` from `react` with `(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;` at the top of the file (pattern in `apps/web/app/components/site/motion/reveal.test.tsx`); `@testing-library` is NOT installed and must not be added.
- **Commands** (run from the directory named): `npm test` / `npx vitest run <file>` in `apps/worker`, `packages/llm`, `apps/workers/chatbot`, `apps/web`; `npx tsc --noEmit` (or `npm run check-types`) in any workspace; from the repo root `npm run check-types`, `npm test`, `npm run lint`, `npm run build`. `npx wrangler deploy --dry-run` inside a worker directory proves it bundles without deploying.
- **Temp files** go in the session scratchpad or `mktemp -d`, never `/tmp`.
- **Branch:** `feat/multi-provider-llm` (already exists, head `df11685`, holds the spec). Plain PR to `main`; the user merges. Add the `e2e` label before merge so the staging gate runs (no E2E spec touches a picker, so the gate is unaffected in content).
- **Commit trailers:** every commit message ends with these two lines, passed as the second `-m` argument exactly as the commit commands below show:
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB`.
- **Remix `.js` route twins:** none exist today. If a build emits one beside an edited `.tsx` route under `apps/web/app/routes/`, delete it before committing.

## Decisions made while planning (surfaced for the owner; none block execution)

1. **Google Pro resolves to a preview id when the preview is the newest generation.** The spec excludes `-preview` ids from the OpenRouter ranking. Applied literally, the Google `pro` family would resolve to `google/gemini-2.5-pro` (the only non-preview Pro), two generations behind the `gemini-3.1-pro-preview` the catalogue offers today, and the pipeline default itself is a preview id. Rule used: the Google family patterns accept an optional `-preview` suffix; the highest version wins and, at equal versions, the stable id beats the preview. `-exp` and dated ids (`-\d{4}$`) stay excluded. Today this yields `gemini-3.1-pro-preview`, `gemini-3.8-flash`, `gemini-3.5-flash-lite`, plus the pinned default.
2. **Anthropic ids are canonicalised for ranking and pricing, called verbatim.** Anthropic's list may carry hyphenated versions or dated snapshots (`claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`). The ranking regex accepts `^claude-(fable|opus|sonnet|haiku)-(\d+(?:[.-]\d+)?)(-\d{8})?$`, compares the dotted version, prefers the undated id at equal versions, and prices through the canonical dotted slug (`anthropic/claude-sonnet-4.5`). The direct id embeds the listed id verbatim so the API is always called with a name it published.
3. **Retries move into the client; callers keep a smaller loop.** `chatComplete` retries 429/5xx/network errors up to `maxRetries` (default 3, back-off 3 s, 6 s, 9 s). The research worker's loop shrinks from three attempts of the chosen model to two (both for output validity) plus the default-model rescue. The text worker gains the same rescue (chosen model, then the default) before its research-derived fallback copy. The theme generator passes `maxRetries: 1` (a developer is waiting on the request) and the chatbot passes `maxRetries: 0` (a visitor is waiting) but falls back to the default model once.
4. **Read and settings endpoints under `/api/ai` are registered before the 10-per-hour AI rate limiter.** `GET /models`, `GET /chatbot-model` and `POST /chatbot-model` are cheap KV reads or writes; counting them against the generation budget would let five AI Deploy page loads an hour lock the developer out of generation. Hono runs handlers in registration order and stops at the first response, so routes defined before `ai.use("*", rateLimit(...))` never reach it.
5. **A price that no source knows shows as "price unavailable".** A live-discovered id absent from OpenRouter's feed and from the snapshot gets `costPer1MInput: 0, costPer1MOutput: 0, livePricing: false`; the picker label reads `price unavailable` for that exact combination rather than showing `$0`.
6. **A failed OpenRouter feed fetch caches the degraded build for 60 s, not an hour**, so a registry built from the last good copy or the snapshot does not hide recovery, but an outage does not make every settings-save wait on three 10 s timeouts either. `ai:models:v3:last` is written only after a successful feed fetch.
7. **The chatbot's `ai_usage_log.estimated_cost_usd` keeps today's flat per-token estimate.** The chatbot worker has no price data; the row now records the route-qualified model id that actually answered, which is what the billing review in spec section 8 step 4 needs. Per-model cost estimation is out of scope (spec section 9 lists no billing change).
8. **Back-off tests inject a `sleep` function instead of using fake timers.** `chatComplete` takes an optional `deps.sleep`; the tests record the requested delays (3000, 6000, 9000) directly, which asserts the same schedule the spec names without timer mocking.

## File map

| File | Responsibility |
|------|----------------|
| Create `packages/llm/{package.json,tsconfig.json,vitest.config.ts}` | `@repo/llm` workspace package |
| Create `packages/llm/src/ids.ts` | `Route`, `parseModelId`, `isValidModelId`, `priceTwin` |
| Create `packages/llm/src/errors.ts` | `LlmError` and constructors for HTTP, network, abort, missing-key errors |
| Create `packages/llm/src/json.ts` | `stripCodeFences`, `extractJsonObject` |
| Create `packages/llm/src/tokens.ts` | `maxOutputTokensFor` (per-id caps + per-route defaults) |
| Create `packages/llm/src/types.ts` | `ChatRequest`, `ChatResult`, `ProviderKeys`, adapter interfaces |
| Create `packages/llm/src/adapters/{openrouter,openai,anthropic}.ts` | one request builder + response parser per route |
| Create `packages/llm/src/chat.ts` | `chatComplete`: key lookup, effort retry, back-off, JSON extraction |
| Create `packages/llm/src/index.ts` | public surface |
| Create `packages/llm/test/{ids,json,tokens,chat}.test.ts` | unit tests (stubbed fetch, injected sleep) |
| Modify root `package.json` | add research, text, chatbot workers to `workspaces` |
| Modify `apps/workers/{research,text,chatbot}/package.json`; delete their `package-lock.json` | workspace conversion, `@repo/llm` dependency, `check-types` script |
| Modify `packages/utils/src/modelCatalog.ts` | snapshot of all four groups, route/vendor labels, `fallbackPriceFor` |
| Modify `packages/types/src/index.ts:172-194` | new `AIModel` shape (`provider` = route, `vendor`, `effortLevels`) |
| Rewrite `apps/worker/src/services/model-registry.ts` | ranking rules, `buildRegistry`, `fetchRegistrySources`, `getLiveModels(kv, keys)`, async `getModel`, `providerKeysFromEnv` |
| Modify `apps/worker/src/bindings.ts`, `apps/worker/wrangler.toml` | the two new optional secrets |
| Modify `apps/worker/src/services/ai-generator.ts` | `generateShopTheme(..., keys)`; then (Task 5) `chatComplete` |
| Modify `apps/worker/src/routes/ai.ts` | `/models` with keys; chatbot-model endpoints; limiter ordering |
| Modify `apps/worker/src/routes/shops.ts` | validation and degrade against the live registry |
| Modify `apps/worker/vitest.config.mts`; create `apps/worker/test/fixtures/model-feeds.ts`, `apps/worker/test/setup-model-registry.ts` | recorded vendor lists; KV pre-seeded registry for every test file |
| Rewrite/modify `apps/worker/test/{model-catalog,ai-models,model-validation,generate-site.model-effort}.test.ts`; create `model-registry.test.ts`, `ai-chatbot-model.test.ts` | worker tests |
| Modify `apps/workers/research/src/index.ts`, `apps/workers/text/src/index.ts` (+ both `wrangler.toml`) | call `chatComplete`; rescue to default |
| Create `apps/workers/chatbot/src/{model,llm}.ts`, `test/model.test.ts`, `vitest.config.ts`; modify `src/{index,types}.ts`, `wrangler.toml`; delete `src/openrouter.ts` | platform-wide chatbot model |
| Modify `apps/web/app/components/dev-shops/{modelPicker.helpers.ts,ModelPicker.tsx,constants.ts}` (+ tests) | Provider level, vendor sub-groups, effort levels, static fallback |
| Modify `apps/web/app/routes/dev.shops.$shopId.tsx`, `dev.shops.$shopId._index.tsx` | live models on the shop page |
| Create `apps/web/app/routes/api.ai.chatbot-model.tsx`, `apps/web/app/components/dev-shops/ChatbotModelCard.tsx` (+ test); modify `apps/web/app/routes/dev.ai-deploy.tsx` | chatbot model card |
| Create `docs/runbooks/multi-provider-llm-rollout.md`; modify `CLAUDE.md` | operator runbook; repo notes |

---

### Task 1: `@repo/llm` package: ids, errors, JSON extraction, token caps

**Files:**
- Create: `packages/llm/package.json`, `packages/llm/tsconfig.json`, `packages/llm/vitest.config.ts`
- Create: `packages/llm/src/ids.ts`, `packages/llm/src/errors.ts`, `packages/llm/src/json.ts`, `packages/llm/src/tokens.ts`, `packages/llm/src/index.ts`
- Test: `packages/llm/test/ids.test.ts`, `packages/llm/test/json.test.ts`, `packages/llm/test/tokens.test.ts`

**Interfaces:**
- Consumes: nothing (dependency-free).
- Produces (used by Tasks 2, 4, 7, 8, 9): `type Route = "openrouter" | "openai" | "anthropic"`; `parseModelId(id: string): { route: Route; model: string }` (throws `Error("Malformed model id: ...")` on an empty model part); `isValidModelId(id: string): boolean`; `priceTwin(id: string): string`; `maxOutputTokensFor(id: string, requested: number): number`; `class LlmError extends Error { route: Route; model: string; status?: number; retryable: boolean }`; `extractJsonObject(text: string): string`; `stripCodeFences(text: string): string`.

- [ ] **Step 1: Create the package skeleton**

`packages/llm/package.json`:

```json
{
  "name": "@repo/llm",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "check-types": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "@repo/typescript-config": "*",
    "typescript": "5.9.2",
    "vitest": "^4.1.8"
  }
}
```

`packages/llm/tsconfig.json`:

```json
{
  "extends": "@repo/typescript-config/base.json",
  "compilerOptions": {
    "module": "ES2022",
    "moduleResolution": "bundler",
    "noEmit": true,
    "rootDir": "src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "test"]
}
```

`packages/llm/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

Run from the repo root: `npm install` (links `node_modules/@repo/llm` to `packages/llm`; vitest 4.1.8 is already hoisted).
Expected: `ls -la node_modules/@repo/llm` shows a symlink to `../../packages/llm`.

- [ ] **Step 2: Write the failing tests for ids, JSON extraction and token caps**

`packages/llm/test/ids.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseModelId, isValidModelId, priceTwin } from "../src/index";

describe("parseModelId", () => {
  it("routes openai-api/ ids to OpenAI with the vendor model id", () => {
    expect(parseModelId("openai-api/gpt-6-astra")).toEqual({ route: "openai", model: "gpt-6-astra" });
  });

  it("routes anthropic-api/ ids to Anthropic", () => {
    expect(parseModelId("anthropic-api/claude-fable-5.1")).toEqual({
      route: "anthropic",
      model: "claude-fable-5.1",
    });
  });

  it("treats every other id as an OpenRouter slug, unchanged", () => {
    expect(parseModelId("anthropic/claude-sonnet-5")).toEqual({
      route: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
    expect(parseModelId("google/gemini-3.1-flash-lite-preview").route).toBe("openrouter");
  });

  it("trims surrounding whitespace", () => {
    expect(parseModelId("  openai-api/gpt-6-astra ")).toEqual({ route: "openai", model: "gpt-6-astra" });
  });

  it("throws on an empty model part and isValidModelId reports it", () => {
    for (const bad of ["", "   ", "openai-api/", "anthropic-api/", "openai-api/   "]) {
      expect(() => parseModelId(bad)).toThrow(/Malformed model id/);
      expect(isValidModelId(bad)).toBe(false);
    }
    expect(isValidModelId("openai-api/gpt-6-astra")).toBe(true);
    expect(isValidModelId("x-ai/grok-4.6")).toBe(true);
  });
});

describe("priceTwin", () => {
  it("maps direct ids to their OpenRouter slug", () => {
    expect(priceTwin("openai-api/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(priceTwin("anthropic-api/claude-opus-5")).toBe("anthropic/claude-opus-5");
  });

  it("is the identity for OpenRouter ids", () => {
    expect(priceTwin("x-ai/grok-4.6")).toBe("x-ai/grok-4.6");
  });
});
```

`packages/llm/test/json.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractJsonObject, stripCodeFences } from "../src/index";

describe("stripCodeFences", () => {
  it("removes ```json and ``` markers and trims", () => {
    expect(stripCodeFences("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });
});

describe("extractJsonObject", () => {
  it("returns a fenced object without the fences", () => {
    expect(extractJsonObject("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
  });

  it("returns the first balanced object when prose surrounds it", () => {
    expect(extractJsonObject('Sure! Here it is: {"a":{"b":[1,2]}} Hope that helps.')).toBe(
      '{"a":{"b":[1,2]}}',
    );
  });

  it("ignores braces inside string values", () => {
    expect(extractJsonObject('{"text":"a } b { c","n":1} trailing')).toBe('{"text":"a } b { c","n":1}');
  });

  it("ignores escaped quotes inside strings", () => {
    const src = '{"q":"she said \\"}\\"","n":2}';
    expect(extractJsonObject(src + " tail")).toBe(src);
  });

  it("returns the stripped text when there is no object", () => {
    expect(extractJsonObject("  no json here ")).toBe("no json here");
  });

  it("returns from the first brace to the end when the object never closes", () => {
    expect(extractJsonObject('{"a":1')).toBe('{"a":1');
  });
});
```

`packages/llm/test/tokens.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { maxOutputTokensFor } from "../src/index";

describe("maxOutputTokensFor", () => {
  it("caps meta-llama models at 4096", () => {
    expect(maxOutputTokensFor("meta-llama/llama-4-maverick", 8000)).toBe(4096);
    expect(maxOutputTokensFor("meta-llama/llama-4-maverick", 1000)).toBe(1000);
  });

  it("caps Gemini 3.1 Flash Lite at 8000", () => {
    expect(maxOutputTokensFor("google/gemini-3.1-flash-lite-preview", 8000)).toBe(8000);
    expect(maxOutputTokensFor("google/gemini-3.1-flash-lite-preview", 9000)).toBe(8000);
  });

  it("applies the per-route default cap to everything else", () => {
    expect(maxOutputTokensFor("anthropic-api/claude-sonnet-5", 150)).toBe(150);
    expect(maxOutputTokensFor("openai-api/gpt-6-astra", 99_999)).toBe(16_384);
    expect(maxOutputTokensFor("anthropic/claude-sonnet-5", 99_999)).toBe(16_384);
  });

  it("never returns less than 1 and floors fractions", () => {
    expect(maxOutputTokensFor("x-ai/grok-4.6", 0)).toBe(1);
    expect(maxOutputTokensFor("x-ai/grok-4.6", 12.9)).toBe(12);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run from `packages/llm`: `npx vitest run`
Expected: FAIL, "Failed to resolve import ../src/index" (or similar module-not-found).

- [ ] **Step 4: Implement the four modules and the index**

`packages/llm/src/ids.ts`:

```ts
/** Which API a model id is called through. */
export type Route = "openrouter" | "openai" | "anthropic";

export interface ParsedModelId {
  route: Route;
  /** For direct routes the vendor's model id; for OpenRouter the full slug. */
  model: string;
}

const OPENAI_PREFIX = "openai-api/";
const ANTHROPIC_PREFIX = "anthropic-api/";

function checked(route: Route, model: string, original: string): ParsedModelId {
  const trimmed = model.trim();
  if (!trimmed) throw new Error(`Malformed model id: "${original}"`);
  return { route, model: trimmed };
}

/**
 * Split a route-qualified id. `openai-api/X` and `anthropic-api/X` are the
 * direct routes; everything else is an OpenRouter slug used verbatim.
 * Throws on an empty model part (validation rejects such ids upstream).
 */
export function parseModelId(id: string): ParsedModelId {
  const trimmed = (id ?? "").trim();
  if (trimmed.startsWith(OPENAI_PREFIX)) return checked("openai", trimmed.slice(OPENAI_PREFIX.length), id);
  if (trimmed.startsWith(ANTHROPIC_PREFIX)) {
    return checked("anthropic", trimmed.slice(ANTHROPIC_PREFIX.length), id);
  }
  return checked("openrouter", trimmed, id);
}

export function isValidModelId(id: string): boolean {
  try {
    parseModelId(id);
    return true;
  } catch {
    return false;
  }
}

/** The OpenRouter slug that carries a model's price (identity for OpenRouter ids). */
export function priceTwin(id: string): string {
  const { route, model } = parseModelId(id);
  if (route === "openai") return `openai/${model}`;
  if (route === "anthropic") return `anthropic/${model}`;
  return model;
}
```

`packages/llm/src/errors.ts`:

```ts
import type { Route } from "./ids";

export class LlmError extends Error {
  readonly route: Route;
  readonly model: string;
  readonly status: number | undefined;
  readonly retryable: boolean;

  constructor(opts: { route: Route; model: string; status?: number; retryable: boolean; message: string }) {
    super(opts.message);
    this.name = "LlmError";
    this.route = opts.route;
    this.model = opts.model;
    this.status = opts.status;
    this.retryable = opts.retryable;
  }
}

function shortBody(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

export function httpError(route: Route, model: string, status: number, body: string): LlmError {
  return new LlmError({
    route,
    model,
    status,
    retryable: status === 429 || status >= 500,
    message: `${route}/${model}: HTTP ${status} ${shortBody(body)}`.trimEnd(),
  });
}

export function networkError(route: Route, model: string, err: unknown): LlmError {
  const msg = err instanceof Error ? err.message : String(err);
  return new LlmError({ route, model, retryable: true, message: `${route}: ${msg}` });
}

export function abortedError(route: Route, model: string): LlmError {
  return new LlmError({ route, model, retryable: false, message: `${route}: aborted` });
}

export function missingKeyError(route: Route, model: string): LlmError {
  return new LlmError({ route, model, retryable: false, message: `${route}: API key not configured` });
}

export function noContentError(route: Route, model: string, status: number, body: string): LlmError {
  return new LlmError({
    route,
    model,
    status,
    retryable: false,
    message: `${route}/${model}: HTTP ${status} no content ${shortBody(body)}`.trimEnd(),
  });
}
```

`packages/llm/src/json.ts`:

```ts
/** Remove ```json / ``` fences (the rule every caller used to apply by hand). */
export function stripCodeFences(text: string): string {
  return text.replace(/```json|```/g, "").trim();
}

/**
 * The first balanced `{...}` in the text, string-literal aware, so prose
 * before or after a JSON reply does not break JSON.parse. Returns the
 * stripped text when no object starts, and the tail from the first brace
 * when the object never closes (JSON.parse then fails with a clear error).
 */
export function extractJsonObject(text: string): string {
  const s = stripCodeFences(text);
  const start = s.indexOf("{");
  if (start < 0) return s;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s.slice(start);
}
```

`packages/llm/src/tokens.ts`:

```ts
import { parseModelId, type Route } from "./ids";

/** Per-slug caps carried over from the research and text workers. */
const SLUG_PREFIX_CAPS: Array<[prefix: string, cap: number]> = [
  ["meta-llama/", 4096],
  ["google/gemini-3.1-flash-lite", 8000],
];

const ROUTE_CAPS: Record<Route, number> = {
  openrouter: 16_384,
  openai: 16_384,
  anthropic: 16_384,
};

/** The output budget to send: the caller's request, clamped to the model's known cap. */
export function maxOutputTokensFor(id: string, requested: number): number {
  const { route, model } = parseModelId(id);
  const want = Math.max(1, Math.floor(requested));
  if (route === "openrouter") {
    const slug = model.toLowerCase();
    for (const [prefix, cap] of SLUG_PREFIX_CAPS) {
      if (slug.startsWith(prefix)) return Math.min(want, cap);
    }
  }
  return Math.min(want, ROUTE_CAPS[route]);
}
```

`packages/llm/src/index.ts` (Task 2 extends this list):

```ts
export { parseModelId, isValidModelId, priceTwin } from "./ids";
export type { Route, ParsedModelId } from "./ids";
export { LlmError } from "./errors";
export { extractJsonObject, stripCodeFences } from "./json";
export { maxOutputTokensFor } from "./tokens";
```

- [ ] **Step 5: Run the tests and the type check**

Run from `packages/llm`: `npx vitest run` then `npx tsc --noEmit`
Expected: 3 files, all tests PASS; tsc prints nothing.

- [ ] **Step 6: Commit**

```bash
git add packages/llm package-lock.json
git commit -m "feat(llm): add @repo/llm package with route-qualified ids, errors, JSON extraction and token caps" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 2: `@repo/llm` adapters and `chatComplete`

**Files:**
- Create: `packages/llm/src/types.ts`, `packages/llm/src/adapters/openrouter.ts`, `packages/llm/src/adapters/openai.ts`, `packages/llm/src/adapters/anthropic.ts`, `packages/llm/src/chat.ts`
- Modify: `packages/llm/src/index.ts`
- Test: `packages/llm/test/chat.test.ts`

**Interfaces:**
- Consumes (Task 1): `parseModelId`, `maxOutputTokensFor`, `extractJsonObject`, `LlmError` constructors.
- Produces (used by Tasks 5, 7, 8, 9):

```ts
type Effort = "low" | "medium" | "high";
interface ProviderKeys { openrouter?: string; openai?: string; anthropic?: string }
interface ChatMessage { role: "user" | "assistant"; content: string }
interface ChatRequest {
  modelId: string; system?: string; messages: ChatMessage[]; effort?: Effort; maxTokens: number;
  jsonOnly?: boolean; signal?: AbortSignal;
  /** Retries on 429 / 5xx / network errors (default 3: 3 s, 6 s, 9 s). */
  maxRetries?: number;
  /** OpenRouter X-Title header (default "Pivot Parlor"). */
  appTitle?: string;
}
interface ChatResult { text: string; usage: { inputTokens: number; outputTokens: number } | null; route: Route; model: string }
interface ChatDeps { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }
function chatComplete(req: ChatRequest, keys: ProviderKeys, deps?: ChatDeps): Promise<ChatResult>;
```

- [ ] **Step 1: Write the failing adapter and retry tests**

`packages/llm/test/chat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { chatComplete, LlmError, type ChatRequest, type ProviderKeys } from "../src/index";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

/** Queue of response factories; every call is recorded with its parsed JSON body. */
function makeFetch(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(input), init: init ?? {}, body });
    const next = responses.shift();
    if (!next) throw new Error("no more stubbed responses");
    return next();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function sleeper() {
  const sleeps: number[] = [];
  return { sleeps, sleep: async (ms: number) => void sleeps.push(ms) };
}

const KEYS: ProviderKeys = { openrouter: "or-key", openai: "oa-key", anthropic: "an-key" };

const openAiStyle = (content: string) => () =>
  Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 11, completion_tokens: 7 },
  });

const anthropicStyle = (parts: string[]) => () =>
  Response.json({
    content: parts.map((text) => ({ type: "text", text })),
    usage: { input_tokens: 5, output_tokens: 3 },
  });

const base: Omit<ChatRequest, "modelId"> = {
  system: "You are terse.",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 500,
};

describe("chatComplete request shapes", () => {
  it("OpenRouter: chat/completions with today's headers, reasoning.effort and response_format when jsonOnly", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle('{"ok":true}')]);
    const res = await chatComplete(
      { ...base, modelId: "anthropic/claude-sonnet-5", effort: "high", jsonOnly: true, appTitle: "Pivot Parlor Research" },
      KEYS,
      { fetch: fetchImpl },
    );
    const call = calls[0]!;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer or-key");
    expect(headers["HTTP-Referer"]).toBe("https://pivotparlor.com");
    expect(headers["X-Title"]).toBe("Pivot Parlor Research");
    expect(call.body.model).toBe("anthropic/claude-sonnet-5");
    expect(call.body.max_tokens).toBe(500);
    expect(call.body.reasoning).toEqual({ effort: "high" });
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect(call.body.messages).toEqual([
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
    ]);
    expect(res).toEqual({
      text: '{"ok":true}',
      usage: { inputTokens: 11, outputTokens: 7 },
      route: "openrouter",
      model: "anthropic/claude-sonnet-5",
    });
  });

  it("OpenRouter: omits reasoning and response_format when not asked", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle("hello")]);
    await chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl });
    expect(calls[0]!.body).not.toHaveProperty("reasoning");
    expect(calls[0]!.body).not.toHaveProperty("response_format");
    expect((calls[0]!.init.headers as Record<string, string>)["X-Title"]).toBe("Pivot Parlor");
  });

  it("OpenAI: /v1/chat/completions with max_completion_tokens and reasoning_effort", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle("hello")]);
    const res = await chatComplete(
      { ...base, modelId: "openai-api/gpt-6-astra", effort: "low", jsonOnly: true },
      KEYS,
      { fetch: fetchImpl },
    );
    const call = calls[0]!;
    expect(call.url).toBe("https://api.openai.com/v1/chat/completions");
    expect((call.init.headers as Record<string, string>).Authorization).toBe("Bearer oa-key");
    expect(call.body.model).toBe("gpt-6-astra");
    expect(call.body.max_completion_tokens).toBe(500);
    expect(call.body).not.toHaveProperty("max_tokens");
    expect(call.body.reasoning_effort).toBe("low");
    expect(call.body).not.toHaveProperty("reasoning");
    expect(call.body.response_format).toEqual({ type: "json_object" });
    expect((call.body.messages as unknown[])[0]).toEqual({ role: "system", content: "You are terse." });
    expect(res.route).toBe("openai");
    expect(res.model).toBe("gpt-6-astra");
  });

  it("Anthropic: /v1/messages with x-api-key, anthropic-version, top-level system and output_config.effort", async () => {
    const { fetchImpl, calls } = makeFetch([anthropicStyle(["Hel", "lo"])]);
    const res = await chatComplete(
      { ...base, modelId: "anthropic-api/claude-opus-5", effort: "medium" },
      KEYS,
      { fetch: fetchImpl },
    );
    const call = calls[0]!;
    expect(call.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = call.init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("an-key");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(call.body.model).toBe("claude-opus-5");
    expect(call.body.max_tokens).toBe(500);
    expect(call.body.system).toBe("You are terse.");
    expect(call.body.output_config).toEqual({ effort: "medium" });
    expect(call.body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(res.text).toBe("Hello");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 3 });
  });

  it("Anthropic: drops leading assistant turns and merges consecutive same-role turns", async () => {
    const { fetchImpl, calls } = makeFetch([anthropicStyle(["ok"])]);
    await chatComplete(
      {
        modelId: "anthropic-api/claude-haiku-4.5",
        maxTokens: 100,
        messages: [
          { role: "assistant", content: "Welcome!" },
          { role: "user", content: "a" },
          { role: "user", content: "b" },
          { role: "assistant", content: "c" },
          { role: "user", content: "d" },
        ],
      },
      KEYS,
      { fetch: fetchImpl },
    );
    expect(calls[0]!.body.messages).toEqual([
      { role: "user", content: "a\n\nb" },
      { role: "assistant", content: "c" },
      { role: "user", content: "d" },
    ]);
    expect(calls[0]!.body).not.toHaveProperty("system");
  });

  it("applies the token cap for the model before sending", async () => {
    const { fetchImpl, calls } = makeFetch([openAiStyle("x")]);
    await chatComplete({ ...base, modelId: "meta-llama/llama-4-maverick", maxTokens: 9000 }, KEYS, { fetch: fetchImpl });
    expect(calls[0]!.body.max_tokens).toBe(4096);
  });

  it("extracts the JSON object from a chatty reply when jsonOnly", async () => {
    const { fetchImpl } = makeFetch([openAiStyle('Here you go:\n```json\n{"a":1}\n```\nEnjoy')]);
    const res = await chatComplete({ ...base, modelId: "x-ai/grok-4.6", jsonOnly: true }, KEYS, { fetch: fetchImpl });
    expect(res.text).toBe('{"a":1}');
  });
});

describe("chatComplete failure handling", () => {
  it("retries once without effort when OpenAI rejects reasoning_effort with a 400", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning_effort'" } }), { status: 400 }),
      openAiStyle("fine"),
    ]);
    const res = await chatComplete({ ...base, modelId: "openai-api/gpt-5.6-luna", effort: "high" }, KEYS, { fetch: fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.reasoning_effort).toBe("high");
    expect(calls[1]!.body).not.toHaveProperty("reasoning_effort");
    expect(res.text).toBe("fine");
  });

  it("retries once without effort on any OpenRouter 400 (today's worker rule)", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("bad request", { status: 400 }),
      openAiStyle("fine"),
    ]);
    await chatComplete({ ...base, modelId: "deepseek/deepseek-v4-pro", effort: "low" }, KEYS, { fetch: fetchImpl });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).not.toHaveProperty("reasoning");
  });

  it("does not retry a 400 that was sent without effort", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("bad request", { status: 400 })]);
    await expect(chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl })).rejects.toMatchObject({
      name: "LlmError",
      status: 400,
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it("backs off 3 s, 6 s, 9 s on 429 / 5xx and then succeeds", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("slow down", { status: 429 }),
      () => new Response("boom", { status: 503 }),
      () => new Response("boom", { status: 500 }),
      openAiStyle("finally"),
    ]);
    const s = sleeper();
    const res = await chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl, sleep: s.sleep });
    expect(res.text).toBe("finally");
    expect(calls).toHaveLength(4);
    expect(s.sleeps).toEqual([3000, 6000, 9000]);
  });

  it("gives up after maxRetries with a retryable LlmError naming route, model and status", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("rate limited", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
      () => new Response("rate limited", { status: 429 }),
    ]);
    const s = sleeper();
    const err = await chatComplete({ ...base, modelId: "anthropic/claude-sonnet-5" }, KEYS, { fetch: fetchImpl, sleep: s.sleep }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toBe("openrouter/anthropic/claude-sonnet-5: HTTP 429 rate limited");
    expect((err as LlmError).retryable).toBe(true);
    expect((err as LlmError).status).toBe(429);
    expect(calls).toHaveLength(4);
  });

  it("honours maxRetries: 0", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("boom", { status: 500 })]);
    await expect(
      chatComplete({ ...base, modelId: "x-ai/grok-4.6", maxRetries: 0 }, KEYS, { fetch: fetchImpl, sleep: async () => {} }),
    ).rejects.toBeInstanceOf(LlmError);
    expect(calls).toHaveLength(1);
  });

  it("does not retry a 401", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("nope", { status: 401 })]);
    await expect(chatComplete({ ...base, modelId: "openai-api/gpt-6-astra" }, KEYS, { fetch: fetchImpl })).rejects.toMatchObject({
      status: 401,
      retryable: false,
      message: "openai/gpt-6-astra: HTTP 401 nope",
    });
    expect(calls).toHaveLength(1);
  });

  it("retries network errors and reports them as <route>: <message>", async () => {
    const { fetchImpl } = makeFetch([
      () => {
        throw new Error("socket hang up");
      },
      openAiStyle("ok"),
    ]);
    const s = sleeper();
    const res = await chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl, sleep: s.sleep });
    expect(res.text).toBe("ok");
    expect(s.sleeps).toEqual([3000]);

    const { fetchImpl: dead } = makeFetch([
      () => {
        throw new Error("socket hang up");
      },
    ]);
    await expect(
      chatComplete({ ...base, modelId: "x-ai/grok-4.6", maxRetries: 0 }, KEYS, { fetch: dead }),
    ).rejects.toMatchObject({ message: "openrouter: socket hang up", retryable: true });
  });

  it("stops on abort without retrying", async () => {
    const controller = new AbortController();
    const { fetchImpl, calls } = makeFetch([
      () => {
        controller.abort();
        const e = new Error("The operation was aborted");
        e.name = "AbortError";
        throw e;
      },
    ]);
    await expect(
      chatComplete({ ...base, modelId: "x-ai/grok-4.6", signal: controller.signal }, KEYS, { fetch: fetchImpl }),
    ).rejects.toMatchObject({ message: "openrouter: aborted", retryable: false });
    expect(calls).toHaveLength(1);
  });

  it("throws before any fetch when the route's key is missing", async () => {
    const { fetchImpl, calls } = makeFetch([]);
    const err = await chatComplete({ ...base, modelId: "openai-api/gpt-6-astra" }, { openrouter: "k" }, { fetch: fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).message).toBe("openai: API key not configured");
    expect((err as LlmError).status).toBeUndefined();
    expect((err as LlmError).retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("treats a 200 with no usable content as a non-retryable error", async () => {
    const { fetchImpl } = makeFetch([() => Response.json({ choices: [] })]);
    await expect(chatComplete({ ...base, modelId: "x-ai/grok-4.6" }, KEYS, { fetch: fetchImpl })).rejects.toMatchObject({
      retryable: false,
      status: 200,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run from `packages/llm`: `npx vitest run test/chat.test.ts`
Expected: FAIL, `chatComplete` is not exported from `../src/index`.

- [ ] **Step 3: Implement the shared types, the three adapters and `chatComplete`**

`packages/llm/src/types.ts`:

```ts
import type { Route } from "./ids";

export type Effort = "low" | "medium" | "high";

export interface ProviderKeys {
  openrouter?: string;
  openai?: string;
  anthropic?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  /** Route-qualified id (see parseModelId). */
  modelId: string;
  system?: string;
  messages: ChatMessage[];
  effort?: Effort;
  /** Requested output budget; clamped by maxOutputTokensFor. */
  maxTokens: number;
  /** Ask for a JSON object and return only the first balanced object. */
  jsonOnly?: boolean;
  signal?: AbortSignal;
  /** Retries on 429 / 5xx / network errors (default 3: 3 s, 6 s, 9 s back-off). */
  maxRetries?: number;
  /** OpenRouter X-Title header (default "Pivot Parlor"). */
  appTitle?: string;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  usage: ChatUsage | null;
  /** What was actually called. */
  route: Route;
  model: string;
}

/** Injection points for tests (real fetch and setTimeout by default). */
export interface ChatDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Everything an adapter needs; `model` is the vendor id / OpenRouter slug. */
export interface AdapterRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  effort?: Effort;
  maxTokens: number;
  jsonOnly: boolean;
  signal?: AbortSignal;
  appTitle: string;
}

export interface AdapterResponse {
  text: string;
  usage: ChatUsage | null;
}

export interface Adapter {
  route: Route;
  buildRequest(req: AdapterRequest, apiKey: string): { url: string; init: RequestInit };
  /** null when the body carries no usable text. */
  parseResponse(body: unknown): AdapterResponse | null;
  /** True when a 400 body is complaining about the effort parameter. */
  isEffortRejection(body: string): boolean;
}
```

`packages/llm/src/adapters/openrouter.ts`:

```ts
import type { Adapter, ChatUsage } from "../types";

interface OpenAiStyleBody {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Shared by OpenRouter and OpenAI: both speak the chat/completions shape. */
export function parseOpenAiStyle(body: unknown): { text: string; usage: ChatUsage | null } | null {
  const o = (body ?? {}) as OpenAiStyleBody;
  const content = o.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) return null;
  const usage =
    typeof o.usage?.prompt_tokens === "number" && typeof o.usage?.completion_tokens === "number"
      ? { inputTokens: o.usage.prompt_tokens, outputTokens: o.usage.completion_tokens }
      : null;
  return { text: content, usage };
}

export const openRouterAdapter: Adapter = {
  route: "openrouter",
  buildRequest(req, apiKey) {
    return {
      url: "https://openrouter.ai/api/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://pivotparlor.com",
          "X-Title": req.appTitle,
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.effort ? { reasoning: { effort: req.effort } } : {}),
          ...(req.jsonOnly ? { response_format: { type: "json_object" } } : {}),
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            ...req.messages,
          ],
        }),
        signal: req.signal,
      },
    };
  },
  parseResponse: parseOpenAiStyle,
  // Some OpenRouter providers reject the reasoning block with an unspecific
  // 400; the research and text workers always retried without it.
  isEffortRejection: () => true,
};
```

`packages/llm/src/adapters/openai.ts`:

```ts
import type { Adapter } from "../types";
import { parseOpenAiStyle } from "./openrouter";

export const openAiAdapter: Adapter = {
  route: "openai",
  buildRequest(req, apiKey) {
    return {
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: req.model,
          max_completion_tokens: req.maxTokens,
          ...(req.effort ? { reasoning_effort: req.effort } : {}),
          ...(req.jsonOnly ? { response_format: { type: "json_object" } } : {}),
          messages: [
            ...(req.system ? [{ role: "system", content: req.system }] : []),
            ...req.messages,
          ],
        }),
        signal: req.signal,
      },
    };
  },
  parseResponse: parseOpenAiStyle,
  isEffortRejection: (body) => /reasoning_effort|reasoning|effort/i.test(body),
};
```

`packages/llm/src/adapters/anthropic.ts`:

```ts
import type { Adapter, ChatMessage } from "../types";

interface AnthropicBody {
  content?: Array<{ type?: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * The Messages API requires the first turn to be a user turn and rejects two
 * consecutive turns with the same role: drop leading assistant turns and merge
 * runs of the same role.
 */
export function normalizeAnthropicMessages(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (out.length === 0 && m.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

export const anthropicAdapter: Adapter = {
  route: "anthropic",
  buildRequest(req, apiKey) {
    return {
      url: "https://api.anthropic.com/v1/messages",
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: req.model,
          max_tokens: req.maxTokens,
          ...(req.system ? { system: req.system } : {}),
          ...(req.effort ? { output_config: { effort: req.effort } } : {}),
          messages: normalizeAnthropicMessages(req.messages),
        }),
        signal: req.signal,
      },
    };
  },
  parseResponse(body) {
    const o = (body ?? {}) as AnthropicBody;
    const text = (o.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    if (!text.trim()) return null;
    const usage =
      typeof o.usage?.input_tokens === "number" && typeof o.usage?.output_tokens === "number"
        ? { inputTokens: o.usage.input_tokens, outputTokens: o.usage.output_tokens }
        : null;
    return { text, usage };
  },
  isEffortRejection: (body) => /output_config|effort/i.test(body),
};
```

`packages/llm/src/chat.ts`:

```ts
import { parseModelId, type Route } from "./ids";
import { abortedError, httpError, LlmError, missingKeyError, networkError, noContentError } from "./errors";
import { extractJsonObject } from "./json";
import { maxOutputTokensFor } from "./tokens";
import { openRouterAdapter } from "./adapters/openrouter";
import { openAiAdapter } from "./adapters/openai";
import { anthropicAdapter } from "./adapters/anthropic";
import type { Adapter, AdapterRequest, ChatDeps, ChatRequest, ChatResult, ProviderKeys } from "./types";

const ADAPTERS: Record<Route, Adapter> = {
  openrouter: openRouterAdapter,
  openai: openAiAdapter,
  anthropic: anthropicAdapter,
};

const BACKOFF_MS = [3000, 6000, 9000] as const;
const DEFAULT_MAX_RETRIES = 3;

function isAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted) || (err instanceof Error && err.name === "AbortError");
}

/**
 * One chat completion through whichever route the id names. Shared rules:
 * effort retry (one 400 mentioning effort is retried without it), 429 / 5xx /
 * network back-off, JSON extraction, uniform LlmError text.
 */
export async function chatComplete(req: ChatRequest, keys: ProviderKeys, deps: ChatDeps = {}): Promise<ChatResult> {
  const { route, model } = parseModelId(req.modelId);
  const apiKey = keys[route];
  if (!apiKey) throw missingKeyError(route, model);

  const adapter = ADAPTERS[route];
  const doFetch: typeof fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = req.maxRetries ?? DEFAULT_MAX_RETRIES;

  const base: AdapterRequest = {
    model,
    system: req.system,
    messages: req.messages,
    effort: req.effort,
    maxTokens: maxOutputTokensFor(req.modelId, req.maxTokens),
    jsonOnly: req.jsonOnly === true,
    signal: req.signal,
    appTitle: req.appTitle ?? "Pivot Parlor",
  };

  let effort = base.effort;
  let attempt = 0;

  const backoff = async (): Promise<void> => {
    await sleep(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!);
    attempt++;
    if (req.signal?.aborted) throw abortedError(route, model);
  };

  for (;;) {
    const { url, init } = adapter.buildRequest({ ...base, effort }, apiKey);
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (isAbort(err, req.signal)) throw abortedError(route, model);
      if (attempt < maxRetries) {
        await backoff();
        continue;
      }
      throw networkError(route, model, err);
    }

    const raw = await res.text();
    if (res.ok) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new LlmError({
          route,
          model,
          status: res.status,
          retryable: false,
          message: `${route}/${model}: HTTP ${res.status} non-JSON body`,
        });
      }
      const out = adapter.parseResponse(parsed);
      if (!out) throw noContentError(route, model, res.status, raw);
      return {
        text: base.jsonOnly ? extractJsonObject(out.text) : out.text.trim(),
        usage: out.usage,
        route,
        model,
      };
    }

    if (effort && res.status === 400 && adapter.isEffortRejection(raw)) {
      effort = undefined; // exactly one retry without effort
      continue;
    }
    const err = httpError(route, model, res.status, raw);
    if (err.retryable && attempt < maxRetries) {
      await backoff();
      continue;
    }
    throw err;
  }
}
```

Replace `packages/llm/src/index.ts` with:

```ts
export { parseModelId, isValidModelId, priceTwin } from "./ids";
export type { Route, ParsedModelId } from "./ids";
export { LlmError } from "./errors";
export { extractJsonObject, stripCodeFences } from "./json";
export { maxOutputTokensFor } from "./tokens";
export { chatComplete } from "./chat";
export { normalizeAnthropicMessages } from "./adapters/anthropic";
export type {
  Effort,
  ProviderKeys,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatUsage,
  ChatDeps,
} from "./types";
```

- [ ] **Step 4: Run the tests and the type check**

Run from `packages/llm`: `npx vitest run` then `npx tsc --noEmit`
Expected: 4 files PASS (ids, json, tokens, chat); tsc prints nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/llm
git commit -m "feat(llm): chatComplete with OpenRouter, OpenAI and Anthropic adapters, effort retry and back-off" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 3: Make the research, text and chatbot workers npm workspaces

**Files:**
- Modify: `package.json` (root, `workspaces`)
- Modify: `apps/workers/research/package.json`, `apps/workers/text/package.json`, `apps/workers/chatbot/package.json`
- Delete: `apps/workers/research/package-lock.json`, `apps/workers/text/package-lock.json`, `apps/workers/chatbot/package-lock.json` (tracked files) and the three untracked `apps/workers/*/node_modules/` directories
- Regenerated: root `package-lock.json`

**Interfaces:**
- Consumes: `@repo/llm` (Task 1).
- Produces: `node_modules/pivot-parlor-research`, `node_modules/pivot-parlor-text`, `node_modules/pivot-parlor-chatbot` workspace links; `npm run check-types --workspace=<name>` works for each; Tasks 7, 8, 9 can `import { chatComplete } from "@repo/llm"`.

Precedent: `apps/workers/booking` is already a workspace, depends on `@repo/utils`, and deploys with the identical `tsconfig.json` shape (`moduleResolution: "bundler"`, `rootDir: "src"`). No tsconfig change is needed.

- [ ] **Step 1: Record the baseline**

Run from the repo root:

```bash
npm run check-types --workspace=pivot-parlor-booking
(cd apps/workers/research && npx tsc --noEmit); echo "research rc=$?"
(cd apps/workers/text && npx tsc --noEmit); echo "text rc=$?"
(cd apps/workers/chatbot && npx tsc --noEmit); echo "chatbot rc=$?"
```

Expected: all three `rc=0`. If one is non-zero before you change anything, stop and report it (it is a pre-existing defect, not yours to fix in this task).

- [ ] **Step 2: Add the three workers to the root workspaces**

In `package.json` (root) replace:

```json
  "workspaces": [
    "apps/*",
    "apps/workers/booking",
    "packages/*"
  ]
```

with:

```json
  "workspaces": [
    "apps/*",
    "apps/workers/booking",
    "apps/workers/chatbot",
    "apps/workers/research",
    "apps/workers/text",
    "packages/*"
  ]
```

- [ ] **Step 3: Give each worker the shared dependency and the Turbo script**

`apps/workers/research/package.json` (whole file):

```json
{
  "name": "pivot-parlor-research",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "check-types": "tsc --noEmit",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@repo/llm": "*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.9.2",
    "wrangler": "^4.74.0"
  }
}
```

`apps/workers/text/package.json` (whole file):

```json
{
  "name": "pivot-parlor-text",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "check-types": "tsc --noEmit",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@repo/llm": "*"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.9.2",
    "wrangler": "^4.74.0"
  }
}
```

`apps/workers/chatbot/package.json` (whole file; `test` and `vitest` are used by Task 9):

```json
{
  "name": "pivot-parlor-chatbot",
  "private": true,
  "version": "0.0.1",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "check-types": "tsc --noEmit",
    "test": "vitest run",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@repo/llm": "*",
    "hono": "^4.6.12"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20241205.0",
    "typescript": "^5.9.2",
    "vitest": "^4.1.8",
    "wrangler": "^4.76.0"
  }
}
```

- [ ] **Step 4: Remove the per-worker lockfiles and node_modules, then install from the root**

```bash
git rm apps/workers/research/package-lock.json apps/workers/text/package-lock.json apps/workers/chatbot/package-lock.json
rm -rf apps/workers/research/node_modules apps/workers/text/node_modules apps/workers/chatbot/node_modules
npm install
ls -la node_modules/pivot-parlor-research node_modules/pivot-parlor-text node_modules/pivot-parlor-chatbot node_modules/@repo/llm
```

Expected: `git rm` removes three tracked files; the four `ls` entries are symlinks into `apps/workers/*` and `packages/llm`; `git status` shows `package-lock.json` modified.

- [ ] **Step 5: Verify every workspace still type-checks and the workers still bundle**

```bash
npm run check-types
(cd apps/workers/research && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"); echo "research bundle rc=$?"
(cd apps/workers/text && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"); echo "text bundle rc=$?"
(cd apps/workers/chatbot && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"); echo "chatbot bundle rc=$?"
```

Expected: Turbo reports the three new workspaces among the `check-types` tasks, all successful; each dry run prints "--dry-run: exiting now." with `rc=0`. (A dry run needs no Cloudflare login; if wrangler still asks for one, run it with `CLOUDFLARE_API_TOKEN=x` set to any non-empty string, since nothing is uploaded.)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json apps/workers/research/package.json apps/workers/text/package.json apps/workers/chatbot/package.json
git commit -m "build: make research, text and chatbot workers npm workspaces depending on @repo/llm" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

(The `git rm` from Step 4 is already staged.)

---

### Task 4: Catalogue snapshot, live registry, validation against the registry

This is the core backend task. Everything in it must move together to keep the tree green: the catalogue and `AIModel` type change shape, the registry is rewritten around them, and the three call sites (theme generator, AI routes, shop routes) switch to the async registry.

**Files:**
- Modify: `packages/utils/src/modelCatalog.ts` (rewrite)
- Modify: `packages/types/src/index.ts:172-194` (the `TextEffort` + `AIModel` block)
- Modify: `apps/worker/package.json` (add `"@repo/llm": "*"` to `dependencies`)
- Rewrite: `apps/worker/src/services/model-registry.ts`
- Modify: `apps/worker/src/bindings.ts:14-15`, `apps/worker/wrangler.toml:68-71`
- Modify: `apps/worker/src/services/ai-generator.ts:1-2, 212-262`
- Modify: `apps/worker/src/routes/ai.ts:13-17, 50-54, 104-115, 179-203`
- Modify: `apps/worker/src/routes/shops.ts:31-38, 44, 702-708, 800-803, 1173-1181, 1250-1263`
- Modify: `apps/worker/vitest.config.mts`
- Create: `apps/worker/test/fixtures/model-feeds.ts`, `apps/worker/test/setup-model-registry.ts`
- Rewrite: `apps/worker/test/model-catalog.test.ts`, `apps/worker/test/ai-models.test.ts`
- Create: `apps/worker/test/model-registry.test.ts`
- Modify: `apps/worker/test/model-validation.test.ts`, `apps/worker/test/generate-site.model-effort.test.ts:59-61`

**Interfaces:**
- Consumes (Task 1): `parseModelId`, `priceTwin`, `type ProviderKeys` from `@repo/llm`.
- Produces:
  - `@repo/utils`: `type ModelRoute`, `ROUTE_LABELS`, `ROUTE_ORDER`, `VENDOR_ORDER`, `VENDOR_LABELS`, `vendorLabel(vendor)`, `MODEL_SNAPSHOT`, `catalogModels(kind?)`, `findCatalogModel(id, kind?)`, `fallbackPriceFor(id)`, `DEFAULT_TEXT_MODEL_ID`, `DEFAULT_IMAGE_MODEL_ID`, `type CatalogModel`, `type CatalogModelWithProvider`, `type ModelKind`, `type TextEffort` (unchanged).
  - `@repo/types`: new `AIModel` (fields listed in Step 2) and `type ModelRoute`.
  - `apps/worker/src/services/model-registry.ts`: `MODELS_KV_KEY = "ai:models:v3"`, `MODELS_LAST_GOOD_KV_KEY`, `DEFAULT_THEME_MODEL`, `type OpenRouterFeedModel`, `type AnthropicListedModel`, `type GroupSource<T>`, `type RegistrySources`, `type RegistryInputs`, `type RegistryBuild`, `rankOpenAiIds(ids)`, `rankAnthropicIds(ids)`, `rankOpenRouterText(feed)`, `anthropicCanonical(vendorModel)`, `priceKeyFor(id)`, `buildRegistry(inputs): RegistryBuild`, `fetchRegistrySources(keys, fetchImpl?)`, `getLiveModels(kv, keys): Promise<AIModel[]>`, `getModel(kv, keys, modelId, kind?): Promise<AIModel | undefined>`, `providerKeysFromEnv(env)`, `parseTextEffort(v)`.
  - `generateShopTheme(shopId, shopName, shopType, modelId, styleKeywords, effort, db, kv, keys: ProviderKeys, options?)` (the ninth parameter changes from an OpenRouter key string to `ProviderKeys`).
  - Test fixtures: `OPENROUTER_FEED`, `OPENAI_IDS`, `ANTHROPIC_MODELS` from `apps/worker/test/fixtures/model-feeds.ts`; every worker test file starts with the registry pre-seeded in KV (setup file).

- [ ] **Step 1: Rewrite the shared catalogue as the snapshot of all four groups**

Replace the whole of `packages/utils/src/modelCatalog.ts` with:

```ts
/**
 * Model snapshot: the last-resort fallback and fallback price table for the
 * live model registry (apps/worker/src/services/model-registry.ts), and the
 * offline list the web pickers use when the API is unreachable.
 *
 * The registry discovers the lists live and ranks them by rule; this file
 * only has to be a faithful picture of what the rules produced when it was
 * recorded. Prices are USD per 1M tokens, recorded 2026-09-12 from the public
 * OpenRouter feed (direct ids priced through their OpenRouter twin). The
 * worker test `model-registry.test.ts` checks every price here against the
 * recorded feed fixture, so refresh both together.
 */

export type TextEffort = "low" | "medium" | "high";
export type ModelKind = "text" | "image";
/** Which API a model is called through. */
export type ModelRoute = "openrouter" | "openai" | "anthropic";

export const ROUTE_ORDER: ModelRoute[] = ["openrouter", "openai", "anthropic"];

export const ROUTE_LABELS: Record<ModelRoute, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI API",
  anthropic: "Anthropic API",
};

/** Vendor order inside the OpenRouter group (unchanged from the old catalogue). */
export const VENDOR_ORDER = ["google", "anthropic", "openai", "x-ai", "deepseek"] as const;

export const VENDOR_LABELS: Record<string, string> = {
  google: "Google",
  anthropic: "Anthropic",
  openai: "OpenAI",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
};

export function vendorLabel(vendor: string): string {
  return VENDOR_LABELS[vendor] ?? vendor;
}

export interface CatalogModel {
  /** Route-qualified id: OpenRouter slug, `openai-api/<id>` or `anthropic-api/<id>`. */
  id: string;
  name: string;
  kind: ModelKind;
  provider: ModelRoute;
  /** Model maker: google, anthropic, openai, x-ai, deepseek. */
  vendor: string;
  description: string;
  fallbackInput: number;
  fallbackOutput: number;
  /** Accepts a reasoning-effort parameter (drives the effort select). */
  supportsEffort: boolean;
  recommended?: boolean;
  /** Exactly one model per kind carries this; enforced by tests. */
  isDefault?: boolean;
}

export const DEFAULT_TEXT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";
export const DEFAULT_IMAGE_MODEL_ID = "google/gemini-3.1-flash-image";

const or = (
  vendor: string,
  id: string,
  name: string,
  fallbackInput: number,
  fallbackOutput: number,
  description: string,
  extra: Partial<Pick<CatalogModel, "recommended" | "isDefault" | "supportsEffort" | "kind">> = {},
): CatalogModel => ({
  id,
  name,
  kind: extra.kind ?? "text",
  provider: "openrouter",
  vendor,
  description,
  fallbackInput,
  fallbackOutput,
  supportsEffort: extra.supportsEffort ?? (extra.kind ?? "text") === "text",
  ...(extra.recommended ? { recommended: true } : {}),
  ...(extra.isDefault ? { isDefault: true } : {}),
});

const direct = (
  provider: "openai" | "anthropic",
  vendorModel: string,
  name: string,
  fallbackInput: number,
  fallbackOutput: number,
  description: string,
): CatalogModel => ({
  id: `${provider}-api/${vendorModel}`,
  name,
  kind: "text",
  provider,
  vendor: provider,
  description,
  fallbackInput,
  fallbackOutput,
  supportsEffort: true,
});

/** Group order: OpenRouter text (vendor order), OpenRouter image, OpenAI API, Anthropic API. */
export const MODEL_SNAPSHOT: CatalogModel[] = [
  // OpenRouter, google
  or("google", DEFAULT_TEXT_MODEL_ID, "Gemini 3.1 Flash Lite", 0.25, 1.5, "Pipeline default. Fast and very cheap; solid site copy.", { isDefault: true }),
  or("google", "google/gemini-3.1-pro-preview", "Gemini 3.1 Pro", 2, 12, "Google's flagship; strongest layout sense."),
  or("google", "google/gemini-3.8-flash", "Gemini 3.8 Flash", 0.75, 3.75, "Latest Flash tier; sharper copy than Lite."),
  or("google", "google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 0.3, 2.5, "Latest Flash Lite tier."),
  // OpenRouter, anthropic
  or("anthropic", "anthropic/claude-fable-5.1", "Claude Fable 5.1", 10, 50, "Anthropic's top tier."),
  or("anthropic", "anthropic/claude-opus-5", "Claude Opus 5", 5, 25, "Premium Claude for flagship shops."),
  or("anthropic", "anthropic/claude-sonnet-5", "Claude Sonnet 5", 2, 10, "Best copy quality for the price. Recommended for client-facing sites.", { recommended: true }),
  or("anthropic", "anthropic/claude-haiku-4.5", "Claude Haiku 4.5", 1, 5, "Fast Claude; good copy on a budget."),
  // OpenRouter, openai
  or("openai", "openai/gpt-6-astra", "GPT-6 Astra", 10, 50, "OpenAI's top tier."),
  or("openai", "openai/gpt-5.6-sol", "GPT-5.6 Sol", 2, 10, "OpenAI's premium creative tier."),
  or("openai", "openai/gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, "Strong creative writing and layout sense."),
  or("openai", "openai/gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, "Budget tier of OpenAI's latest family."),
  // OpenRouter, x-ai
  or("x-ai", "x-ai/grok-4.6", "Grok 4.6", 2, 6, "Punchy, direct copy. Good price for a frontier model."),
  or("x-ai", "x-ai/grok-4.20-multi-agent", "Grok 4.20 Multi-Agent", 1.25, 2.5, "Multi-agent Grok; very cheap for its quality."),
  // OpenRouter, deepseek
  or("deepseek", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro", 0.85, 1.7, "Near-frontier quality at budget pricing."),
  or("deepseek", "deepseek/deepseek-v4.1-flash", "DeepSeek V4.1 Flash", 0.15, 0.6, "Cheapest capable model in the catalogue."),
  // OpenRouter image (curated, unchanged)
  or("google", DEFAULT_IMAGE_MODEL_ID, "Gemini 3.1 Flash Image", 0.5, 3, "Pipeline default (Nano Banana 2).", { kind: "image", isDefault: true }),
  or("google", "google/gemini-3.1-flash-lite-image", "Gemini 3.1 Flash Lite Image", 0.25, 1.5, "Cheapest image tier.", { kind: "image" }),
  or("google", "google/gemini-3-pro-image", "Gemini 3 Pro Image", 2, 12, "Highest-fidelity Google image model.", { kind: "image" }),
  or("openai", "openai/gpt-5-image-mini", "GPT-5 Image Mini", 2.5, 2, "OpenAI budget image model.", { kind: "image" }),
  or("openai", "openai/gpt-5.4-image-2", "GPT-5.4 Image 2", 8, 15, "OpenAI's premium image model.", { kind: "image" }),
  // OpenAI API (direct)
  direct("openai", "gpt-6-astra", "GPT-6 Astra", 10, 50, "OpenAI's top tier, called directly."),
  direct("openai", "gpt-5.6-sol", "GPT-5.6 Sol", 2, 10, "OpenAI's premium creative tier, called directly."),
  direct("openai", "gpt-5.6-terra", "GPT-5.6 Terra", 2, 12, "Strong creative writing, called directly."),
  direct("openai", "gpt-5.6-luna", "GPT-5.6 Luna", 0.2, 1.2, "OpenAI's budget tier, called directly."),
  // Anthropic API (direct)
  direct("anthropic", "claude-fable-5.1", "Claude Fable 5.1", 10, 50, "Anthropic's top tier, called directly."),
  direct("anthropic", "claude-opus-5", "Claude Opus 5", 5, 25, "Premium Claude, called directly."),
  direct("anthropic", "claude-sonnet-5", "Claude Sonnet 5", 2, 10, "Best copy quality for the price, called directly."),
  direct("anthropic", "claude-haiku-4.5", "Claude Haiku 4.5", 1, 5, "Fast Claude, called directly."),
];

export interface CatalogModelWithProvider extends CatalogModel {
  providerLabel: string;
  vendorLabel: string;
}

/** Flatten the snapshot, optionally filtered by kind, preserving order. */
export function catalogModels(kind?: ModelKind): CatalogModelWithProvider[] {
  const out: CatalogModelWithProvider[] = [];
  for (const m of MODEL_SNAPSHOT) {
    if (kind && m.kind !== kind) continue;
    out.push({ ...m, providerLabel: ROUTE_LABELS[m.provider], vendorLabel: vendorLabel(m.vendor) });
  }
  return out;
}

/** Resolve a snapshot id; when `kind` is given, a wrong-kind match is undefined. */
export function findCatalogModel(id: string, kind?: ModelKind): CatalogModelWithProvider | undefined {
  return catalogModels(kind).find((m) => m.id === id);
}

/** Fallback USD-per-1M prices for an id the snapshot knows; undefined otherwise. */
export function fallbackPriceFor(id: string): { input: number; output: number } | undefined {
  const m = MODEL_SNAPSHOT.find((x) => x.id === id);
  return m ? { input: m.fallbackInput, output: m.fallbackOutput } : undefined;
}
```

- [ ] **Step 2: Update the shared `AIModel` type**

In `packages/types/src/index.ts` replace lines 172 to 194 (from the `/** Reasoning-effort level ... */` comment through the closing `}` of `AIModel`) with:

```ts
/** Reasoning-effort level for models that support it. */
export type TextEffort = "low" | "medium" | "high";

/** Which API the platform calls for a model: OpenRouter's gateway or a vendor directly. */
export type ModelRoute = "openrouter" | "openai" | "anthropic";

export interface AIModel {
  /** Route-qualified id: an OpenRouter slug ("anthropic/claude-sonnet-5"), "openai-api/<model>" or "anthropic-api/<model>". */
  id: string;
  name: string;
  kind: "text" | "image";
  /** Route the id is called through. */
  provider: ModelRoute;
  /** "OpenRouter", "OpenAI API" or "Anthropic API". */
  providerLabel: string;
  /** Model maker: "google", "anthropic", "openai", "x-ai", "deepseek". */
  vendor: string;
  vendorLabel: string;
  description: string;
  /** USD per 1M input tokens. */
  costPer1MInput: number;
  /** USD per 1M output tokens. */
  costPer1MOutput: number;
  supportsEffort: boolean;
  /** Effort levels the model accepts (subset of low/medium/high); empty when none. */
  effortLevels: TextEffort[];
  recommended: boolean;
  /** True when pricing came from the live OpenRouter feed on the last refresh. */
  livePricing: boolean;
}
```

- [ ] **Step 3: Add the worker's dependency on `@repo/llm` and the two secrets**

`apps/worker/package.json`, `dependencies` block becomes:

```json
  "dependencies": {
    "@repo/llm": "*",
    "@repo/types": "*",
    "@repo/utils": "*",
    "hono": "^4.6.3",
    "stripe": "^20.4.1"
  },
```

Run `npm install` from the root afterwards.

`apps/worker/src/bindings.ts`: after `OPENROUTER_API_KEY: string;` (line 14) insert:

```ts
  /** Direct-vendor keys (spec 2026-09-12 multi-provider LLM). Optional: a missing key hides that provider group. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
```

`apps/worker/wrangler.toml`: in the secrets comment block (lines 68 to 79) add two lines after `#   OPENROUTER_API_KEY`:

```toml
#   OPENAI_API_KEY        (direct OpenAI route; optional, hides the group when unset)
#   ANTHROPIC_API_KEY     (direct Anthropic route; optional, hides the group when unset)
```

- [ ] **Step 4: Write the recorded fixtures and the test setup file**

`apps/worker/test/fixtures/model-feeds.ts`:

```ts
/**
 * Recorded 2026-09-12 from the three live lists: a subset covering the five
 * catalogue vendors plus the distractors the ranking rules must skip
 * (`:batch`/`:free` variants, `-pro` tiers, dated snapshots, `-exp`, image
 * models, legacy families). OpenRouter prices are USD per token, as served.
 * The snapshot in packages/utils/src/modelCatalog.ts is checked against
 * OPENROUTER_FEED by model-registry.test.ts; refresh both together.
 */
import type { AnthropicListedModel, OpenRouterFeedModel } from "../../src/services/model-registry";

function or(
  id: string,
  prompt: number,
  completion: number,
  opts: { name?: string; reasoning?: boolean; out?: string[] } = {},
): OpenRouterFeedModel {
  return {
    id,
    name: opts.name ?? id,
    pricing: { prompt: String(prompt), completion: String(completion) },
    supported_parameters: opts.reasoning === false ? ["max_tokens"] : ["max_tokens", "reasoning"],
    architecture: { output_modalities: opts.out ?? ["text"] },
  };
}

export const OPENROUTER_FEED: OpenRouterFeedModel[] = [
  // google
  or("google/gemini-2.5-pro", 0.00000125, 0.00001, { name: "Google: Gemini 2.5 Pro" }),
  or("google/gemini-3.1-pro-preview", 0.000002, 0.000012, { name: "Google: Gemini 3.1 Pro Preview" }),
  or("google/gemini-3.1-pro-preview:batch", 0.000001, 0.000006),
  or("google/gemini-3-flash-preview", 0.0000005, 0.000003),
  or("google/gemini-3.5-flash", 0.0000015, 0.000009, { name: "Google: Gemini 3.5 Flash" }),
  or("google/gemini-3.8-flash", 0.00000075, 0.00000375, { name: "Google: Gemini 3.8 Flash" }),
  or("google/gemini-3.8-flash:batch", 0.000000375, 0.000001875),
  or("google/gemini-3.1-flash-lite", 0.00000025, 0.0000015, { name: "Google: Gemini 3.1 Flash Lite" }),
  or("google/gemini-3.1-flash-lite-preview", 0.00000025, 0.0000015, { name: "Google: Gemini 3.1 Flash Lite Preview" }),
  or("google/gemini-3.5-flash-lite", 0.0000003, 0.0000025, { name: "Google: Gemini 3.5 Flash Lite" }),
  or("google/gemini-3.1-flash-image", 0.0000005, 0.000003, { name: "Google: Nano Banana 2 (Gemini 3.1 Flash Image)", out: ["image", "text"] }),
  or("google/gemini-3.1-flash-lite-image", 0.00000025, 0.0000015, { out: ["image", "text"] }),
  or("google/gemini-3-pro-image", 0.000002, 0.000012, { out: ["image", "text"] }),
  or("google/gemma-4-31b-it", 0.00000009, 0.00000034),
  // anthropic
  or("anthropic/claude-3-haiku", 0.00000025, 0.00000125, { reasoning: false }),
  or("anthropic/claude-fable-5", 0.00001, 0.00005),
  or("anthropic/claude-fable-5.1", 0.00001, 0.00005, { name: "Anthropic: Claude Fable 5.1" }),
  or("anthropic/claude-fable-5.1:batch", 0.000005, 0.000025),
  or("anthropic/claude-opus-4.8", 0.000005, 0.000025, { name: "Anthropic: Claude Opus 4.8" }),
  or("anthropic/claude-opus-5", 0.000005, 0.000025, { name: "Claude Opus 5" }),
  or("anthropic/claude-sonnet-4.6", 0.000003, 0.000015),
  or("anthropic/claude-sonnet-5", 0.000002, 0.00001, { name: "Anthropic: Claude Sonnet 5" }),
  or("anthropic/claude-haiku-4.5", 0.000001, 0.000005, { name: "Anthropic: Claude Haiku 4.5" }),
  // openai
  or("openai/gpt-6-astra", 0.00001, 0.00005, { name: "OpenAI: GPT-6 Astra" }),
  or("openai/gpt-6-astra-pro", 0.00001, 0.00005),
  or("openai/gpt-6-astra:batch", 0.000005, 0.000025),
  or("openai/gpt-5.6-sol", 0.000002, 0.00001, { name: "OpenAI: GPT-5.6 Sol" }),
  or("openai/gpt-5.6-sol-pro", 0.000002, 0.00001),
  or("openai/gpt-5.6-terra", 0.000002, 0.000012, { name: "OpenAI: GPT-5.6 Terra" }),
  or("openai/gpt-5.6-luna", 0.0000002, 0.0000012, { name: "OpenAI: GPT-5.6 Luna" }),
  or("openai/gpt-5.5", 0.000005, 0.00003),
  or("openai/gpt-5.4-mini", 0.00000075, 0.0000045),
  or("openai/gpt-chat-latest", 0.000005, 0.00003, { reasoning: false }),
  or("openai/gpt-4o-2024-11-20", 0.0000025, 0.00001, { reasoning: false }),
  or("openai/gpt-5-image-mini", 0.0000025, 0.000002, { out: ["image", "text"] }),
  or("openai/gpt-5.4-image-2", 0.000008, 0.000015, { out: ["image", "text"] }),
  // x-ai
  or("x-ai/grok-4.20", 0.00000125, 0.0000025),
  or("x-ai/grok-4.20-multi-agent", 0.00000125, 0.0000025, { name: "SpaceXAI: Grok 4.20 Multi-Agent" }),
  or("x-ai/grok-4.3", 0.00000125, 0.0000025),
  or("x-ai/grok-4.5", 0.000002, 0.000006),
  or("x-ai/grok-4.6", 0.000002, 0.000006, { name: "SpaceXAI: Grok 4.6" }),
  or("x-ai/grok-build-0.1", 0.000001, 0.000002),
  // deepseek
  or("deepseek/deepseek-v3.2-exp", 0.00000027, 0.00000041),
  or("deepseek/deepseek-v4-flash", 0.00000006734, 0.00000013468),
  or("deepseek/deepseek-v4-flash-0731", 0.000000065, 0.00000018),
  or("deepseek/deepseek-v4-pro", 0.000000849816, 0.000001699632, { name: "DeepSeek: DeepSeek V4 Pro 0423" }),
  or("deepseek/deepseek-v4-pro-0813", 0.00000057816, 0.00000173448),
  or("deepseek/deepseek-v4.1-flash", 0.00000015, 0.0000006, { name: "DeepSeek: DeepSeek V4.1 Flash" }),
];

/** OpenAI `GET /v1/models` ids (only `id` matters to the ranking). */
export const OPENAI_IDS: string[] = [
  "gpt-6-astra",
  "gpt-6-astra-pro",
  "gpt-5.6-sol",
  "gpt-5.6-sol-pro",
  "gpt-5.6-terra",
  "gpt-5.6-terra-pro",
  "gpt-5.6-luna",
  "gpt-5.6-luna-pro",
  "gpt-5.5",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-chat-latest",
  "gpt-5-image-mini",
  "gpt-4o",
  "o3",
  "text-embedding-3-small",
];

/** Anthropic `GET /v1/models` entries; `claude-sonnet-4-6-20260210` exercises canonicalisation. */
export const ANTHROPIC_MODELS: AnthropicListedModel[] = [
  { id: "claude-fable-5.1", display_name: "Claude Fable 5.1", capabilities: { effort: { supported: ["low", "medium", "high", "max", "xhigh"] } } },
  { id: "claude-fable-5", display_name: "Claude Fable 5", capabilities: { effort: { supported: ["low", "medium", "high", "max"] } } },
  { id: "claude-opus-5", display_name: "Claude Opus 5", capabilities: { effort: { supported: ["low", "medium", "high", "max"] } } },
  { id: "claude-opus-4.8", display_name: "Claude Opus 4.8", capabilities: { effort: { supported: ["low", "medium", "high"] } } },
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5", capabilities: { effort: { supported: ["medium", "high"] } } },
  { id: "claude-sonnet-4-6-20260210", display_name: "Claude Sonnet 4.6", capabilities: { effort: { supported: ["low", "medium", "high"] } } },
  { id: "claude-haiku-4.5", display_name: "Claude Haiku 4.5", capabilities: { effort: { supported: ["low", "medium", "high"] } } },
  { id: "claude-3-haiku-20240307", display_name: "Claude 3 Haiku" },
];

/** Stub body factories for tests that intercept globalThis.fetch. */
export const feedResponses = {
  openrouter: () => Response.json({ data: OPENROUTER_FEED }),
  openai: () => Response.json({ object: "list", data: OPENAI_IDS.map((id) => ({ id, object: "model", owned_by: "openai" })) }),
  anthropic: () => Response.json({ data: ANTHROPIC_MODELS, has_more: false, first_id: "claude-fable-5.1", last_id: "claude-3-haiku-20240307" }),
};
```

`apps/worker/test/setup-model-registry.ts`:

```ts
/**
 * Test setup: pre-seed the model registry cache so route handlers that
 * validate model ids (settings-save, generate-site, generate-image, theme
 * generation, chatbot-model) never reach the network. Tests that exercise the
 * refresh path delete MODELS_KV_KEY themselves and stub fetch.
 */
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";
import { buildRegistry, MODELS_KV_KEY } from "../src/services/model-registry";
import { ANTHROPIC_MODELS, OPENAI_IDS, OPENROUTER_FEED } from "./fixtures/model-feeds";

beforeAll(async () => {
  const { models } = buildRegistry({
    openrouter: { ok: true, data: OPENROUTER_FEED },
    openai: { ok: true, data: OPENAI_IDS },
    anthropic: { ok: true, data: ANTHROPIC_MODELS },
    previous: null,
  });
  await env.KV.put(MODELS_KV_KEY, JSON.stringify(models));
});
```

`apps/worker/vitest.config.mts`: in `bindings` add after `GOOGLE_AI_API_KEY: "test-google-key",`:

```ts
          OPENAI_API_KEY: "test-openai-key",
          ANTHROPIC_API_KEY: "test-anthropic-key",
```

and change `setupFiles` to:

```ts
    setupFiles: ["./test/apply-schema.ts", "./test/setup-model-registry.ts"],
```

- [ ] **Step 5: Write the failing catalogue and registry unit tests**

Replace the whole of `apps/worker/test/model-catalog.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import {
  MODEL_SNAPSHOT,
  ROUTE_ORDER,
  VENDOR_ORDER,
  catalogModels,
  findCatalogModel,
  fallbackPriceFor,
  vendorLabel,
  DEFAULT_TEXT_MODEL_ID,
  DEFAULT_IMAGE_MODEL_ID,
} from "@repo/utils";

describe("MODEL_SNAPSHOT shape", () => {
  it("lists the three routes in picker order and only those", () => {
    const seen = [...new Set(MODEL_SNAPSHOT.map((m) => m.provider))];
    expect(seen).toEqual(ROUTE_ORDER);
  });

  it("has globally unique ids", () => {
    const ids = MODEL_SNAPSHOT.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("prefixes ids by route and vendor", () => {
    for (const m of MODEL_SNAPSHOT) {
      if (m.provider === "openrouter") expect(m.id.startsWith(`${m.vendor}/`)).toBe(true);
      else {
        expect(m.id.startsWith(`${m.provider}-api/`)).toBe(true);
        expect(m.vendor).toBe(m.provider);
      }
    }
  });

  it("keeps OpenRouter vendors in catalogue order", () => {
    const vendors = [...new Set(MODEL_SNAPSHOT.filter((m) => m.provider === "openrouter" && m.kind === "text").map((m) => m.vendor))];
    expect(vendors).toEqual([...VENDOR_ORDER]);
  });

  it("has exactly one default per kind, matching the exported constants", () => {
    expect(catalogModels("text").filter((m) => m.isDefault).map((m) => m.id)).toEqual([DEFAULT_TEXT_MODEL_ID]);
    expect(catalogModels("image").filter((m) => m.isDefault).map((m) => m.id)).toEqual([DEFAULT_IMAGE_MODEL_ID]);
  });

  it("keeps the pipeline defaults unchanged", () => {
    expect(DEFAULT_TEXT_MODEL_ID).toBe("google/gemini-3.1-flash-lite-preview");
    expect(DEFAULT_IMAGE_MODEL_ID).toBe("google/gemini-3.1-flash-image");
  });

  it("offers the four direct tiers per vendor", () => {
    expect(MODEL_SNAPSHOT.filter((m) => m.provider === "openai").map((m) => m.id)).toEqual([
      "openai-api/gpt-6-astra",
      "openai-api/gpt-5.6-sol",
      "openai-api/gpt-5.6-terra",
      "openai-api/gpt-5.6-luna",
    ]);
    expect(MODEL_SNAPSHOT.filter((m) => m.provider === "anthropic").map((m) => m.id)).toEqual([
      "anthropic-api/claude-fable-5.1",
      "anthropic-api/claude-opus-5",
      "anthropic-api/claude-sonnet-5",
      "anthropic-api/claude-haiku-4.5",
    ]);
  });

  it("keeps image models on OpenRouter only, from google and openai, without effort", () => {
    const images = catalogModels("image");
    expect(images).toHaveLength(5);
    for (const m of images) {
      expect(m.provider).toBe("openrouter");
      expect(m.supportsEffort).toBe(false);
    }
    expect([...new Set(images.map((m) => m.vendor))].sort()).toEqual(["google", "openai"]);
  });

  it("keeps Claude Sonnet 5 via OpenRouter as the only recommended model", () => {
    expect(MODEL_SNAPSHOT.filter((m) => m.recommended).map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
  });

  it("labels routes and vendors", () => {
    expect(findCatalogModel("openai-api/gpt-6-astra")?.providerLabel).toBe("OpenAI API");
    expect(findCatalogModel("anthropic/claude-sonnet-5")?.providerLabel).toBe("OpenRouter");
    expect(findCatalogModel("x-ai/grok-4.6")?.vendorLabel).toBe("xAI");
    expect(vendorLabel("someone-new")).toBe("someone-new");
  });

  it("findCatalogModel resolves ids and enforces kind", () => {
    expect(findCatalogModel("anthropic/claude-sonnet-5", "image")).toBeUndefined();
    expect(findCatalogModel("google/gemini-3.1-flash-image", "image")?.kind).toBe("image");
    expect(findCatalogModel("black-forest-labs/flux-schnell")).toBeUndefined();
  });

  it("fallbackPriceFor returns the snapshot prices and undefined for strangers", () => {
    expect(fallbackPriceFor("openai-api/gpt-6-astra")).toEqual({ input: 10, output: 50 });
    expect(fallbackPriceFor("nobody/nothing")).toBeUndefined();
  });
});
```

Create `apps/worker/test/model-registry.test.ts`:

```ts
/**
 * Pure registry rules against the recorded vendor lists (no KV, no network):
 * ranking per group, price join, fallback order, key gating.
 */
import { describe, it, expect } from "vitest";
import type { AIModel } from "@repo/types";
import { MODEL_SNAPSHOT, catalogModels } from "@repo/utils";
import {
  anthropicCanonical,
  buildRegistry,
  fetchRegistrySources,
  priceKeyFor,
  rankAnthropicIds,
  rankOpenAiIds,
  rankOpenRouterText,
  type OpenRouterFeedModel,
  type RegistryInputs,
} from "../src/services/model-registry";
import { ANTHROPIC_MODELS, OPENAI_IDS, OPENROUTER_FEED, feedResponses } from "./fixtures/model-feeds";

const allOk = (): RegistryInputs => ({
  openrouter: { ok: true, data: OPENROUTER_FEED },
  openai: { ok: true, data: OPENAI_IDS },
  anthropic: { ok: true, data: ANTHROPIC_MODELS },
  previous: null,
});

const round3 = (n: number) => Math.round(n * 1000) / 1000;

describe("rankOpenAiIds", () => {
  it("keeps the newest generation of each of the four tiers, in tier order", () => {
    expect(rankOpenAiIds(OPENAI_IDS)).toEqual(["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
  });

  it("lets a fabricated gpt-7-astra displace gpt-6-astra and ignores -pro, chat-latest and image ids", () => {
    const ranked = rankOpenAiIds([...OPENAI_IDS, "gpt-7-astra", "gpt-7-astra-pro"]);
    expect(ranked[0]).toBe("gpt-7-astra");
    expect(ranked).not.toContain("gpt-7-astra-pro");
    expect(ranked).not.toContain("gpt-chat-latest");
    expect(ranked).not.toContain("gpt-5-image-mini");
  });
});

describe("rankAnthropicIds", () => {
  it("keeps the highest version per family in fable, opus, sonnet, haiku order", () => {
    expect(rankAnthropicIds(ANTHROPIC_MODELS.map((m) => m.id))).toEqual([
      "claude-fable-5.1",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4.5",
    ]);
  });

  it("lets a fabricated claude-opus-6 displace Opus 5", () => {
    expect(rankAnthropicIds([...ANTHROPIC_MODELS.map((m) => m.id), "claude-opus-6"])[1]).toBe("claude-opus-6");
  });

  it("reads hyphenated and dated ids, preferring the undated alias at equal versions", () => {
    expect(rankAnthropicIds(["claude-sonnet-4-6-20260210", "claude-sonnet-4-6", "claude-sonnet-4-5"])).toEqual(["claude-sonnet-4-6"]);
    expect(rankAnthropicIds(["claude-sonnet-4-6-20260210"])).toEqual(["claude-sonnet-4-6-20260210"]);
    expect(anthropicCanonical("claude-sonnet-4-6-20260210")).toBe("claude-sonnet-4.6");
    expect(anthropicCanonical("claude-opus-5")).toBe("claude-opus-5");
    expect(anthropicCanonical("claude-3-haiku-20240307")).toBeNull();
    expect(priceKeyFor("anthropic-api/claude-sonnet-4-6-20260210")).toBe("anthropic/claude-sonnet-4.6");
    expect(priceKeyFor("openai-api/gpt-6-astra")).toBe("openai/gpt-6-astra");
    expect(priceKeyFor("x-ai/grok-4.6")).toBe("x-ai/grok-4.6");
  });
});

describe("rankOpenRouterText", () => {
  it("produces the top tier per family per vendor, vendors in catalogue order, defaults pinned", () => {
    expect(rankOpenRouterText(OPENROUTER_FEED)).toEqual([
      "google/gemini-3.1-flash-lite-preview",
      "google/gemini-3.1-pro-preview",
      "google/gemini-3.8-flash",
      "google/gemini-3.5-flash-lite",
      "anthropic/claude-fable-5.1",
      "anthropic/claude-opus-5",
      "anthropic/claude-sonnet-5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-6-astra",
      "openai/gpt-5.6-sol",
      "openai/gpt-5.6-terra",
      "openai/gpt-5.6-luna",
      "x-ai/grok-4.6",
      "x-ai/grok-4.20-multi-agent",
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4.1-flash",
    ]);
  });

  it("matches the snapshot's OpenRouter text ids exactly", () => {
    expect(rankOpenRouterText(OPENROUTER_FEED)).toEqual(
      MODEL_SNAPSHOT.filter((m) => m.provider === "openrouter" && m.kind === "text").map((m) => m.id),
    );
  });

  it("excludes :variants, -pro, -exp, dated ids, non-text models and legacy families", () => {
    const ranked = rankOpenRouterText(OPENROUTER_FEED);
    for (const excluded of [
      "google/gemini-3.8-flash:batch",
      "openai/gpt-6-astra-pro",
      "deepseek/deepseek-v3.2-exp",
      "deepseek/deepseek-v4-pro-0813",
      "deepseek/deepseek-v4-flash-0731",
      "google/gemini-3.1-flash-image",
      "anthropic/claude-3-haiku",
      "anthropic/claude-opus-4.8",
      "x-ai/grok-build-0.1",
      "google/gemma-4-31b-it",
    ]) {
      expect(ranked).not.toContain(excluded);
    }
  });

  it("prefers a stable id over a preview at the same version and a newer preview over an older stable", () => {
    const withStablePro: OpenRouterFeedModel[] = [
      ...OPENROUTER_FEED,
      { id: "google/gemini-3.1-pro", pricing: { prompt: "0.000002", completion: "0.000012" }, supported_parameters: ["reasoning"], architecture: { output_modalities: ["text"] } },
    ];
    expect(rankOpenRouterText(withStablePro)).toContain("google/gemini-3.1-pro");
    expect(rankOpenRouterText(withStablePro)).not.toContain("google/gemini-3.1-pro-preview");
    // Without any 3.x pro, the stable 2.5 loses to the 3.1 preview (Decision 1).
    expect(rankOpenRouterText(OPENROUTER_FEED)).toContain("google/gemini-3.1-pro-preview");
    expect(rankOpenRouterText(OPENROUTER_FEED)).not.toContain("google/gemini-2.5-pro");
  });

  it("keeps the pinned defaults even when the feed no longer lists them", () => {
    const feed = OPENROUTER_FEED.filter((m) => m.id !== "google/gemini-3.1-flash-lite-preview" && m.id !== "anthropic/claude-sonnet-5");
    const ranked = rankOpenRouterText(feed);
    expect(ranked[0]).toBe("google/gemini-3.1-flash-lite-preview");
    expect(ranked).toContain("anthropic/claude-sonnet-5");
  });
});

describe("buildRegistry", () => {
  it("assembles the four groups in order with route, vendor, prices and effort levels", () => {
    const { models, warnings } = buildRegistry(allOk());
    expect(warnings).toEqual([]);
    expect(models).toHaveLength(29);
    expect(models.map((m) => m.id)).toEqual(MODEL_SNAPSHOT.map((m) => m.id));

    const astra = models.find((m) => m.id === "openai-api/gpt-6-astra")!;
    expect(astra).toMatchObject({
      provider: "openai",
      providerLabel: "OpenAI API",
      vendor: "openai",
      vendorLabel: "OpenAI",
      kind: "text",
      name: "GPT-6 Astra",
      costPer1MInput: 10,
      costPer1MOutput: 50,
      livePricing: true,
      supportsEffort: true,
      effortLevels: ["low", "medium", "high"],
      recommended: false,
    });

    const sonnetDirect = models.find((m) => m.id === "anthropic-api/claude-sonnet-5")!;
    expect(sonnetDirect.name).toBe("Claude Sonnet 5");
    expect(sonnetDirect.effortLevels).toEqual(["medium", "high"]);
    expect(sonnetDirect.livePricing).toBe(true);
    expect(sonnetDirect.costPer1MInput).toBe(2);

    const sonnet = models.find((m) => m.id === "anthropic/claude-sonnet-5")!;
    expect(sonnet).toMatchObject({ provider: "openrouter", vendor: "anthropic", vendorLabel: "Anthropic", recommended: true, name: "Claude Sonnet 5" });
    expect(models.filter((m) => m.recommended).map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);

    const grok = models.find((m) => m.id === "x-ai/grok-4.6")!;
    expect(grok.name).toBe("Grok 4.6"); // vendor prefix stripped from the feed name
    expect(grok.effortLevels).toEqual(["low", "medium", "high"]);

    const image = models.find((m) => m.id === "google/gemini-3.1-flash-image")!;
    expect(image).toMatchObject({ kind: "image", provider: "openrouter", supportsEffort: false, effortLevels: [], livePricing: true, costPer1MInput: 0.5 });
  });

  it("hides a direct group when its key is missing and says so", () => {
    const { models, warnings } = buildRegistry({ ...allOk(), openai: { ok: false, reason: "no-key" } });
    expect(models.some((m) => m.provider === "openai")).toBe(false);
    expect(models.some((m) => m.provider === "anthropic")).toBe(true);
    expect(warnings).toEqual(["openai: API key not configured; group hidden"]);
  });

  it("keeps a group from the previous build when its fetch failed", () => {
    const previous: AIModel[] = buildRegistry(allOk()).models.map((m) =>
      m.id === "anthropic-api/claude-opus-5" ? { ...m, name: "Opus from cache" } : m,
    );
    const { models } = buildRegistry({ ...allOk(), anthropic: { ok: false, reason: "fetch-failed" }, previous });
    expect(models.find((m) => m.id === "anthropic-api/claude-opus-5")?.name).toBe("Opus from cache");
    expect(models.filter((m) => m.provider === "anthropic")).toHaveLength(4);
  });

  it("falls back to the snapshot for a failed group with no previous build, still priced from the feed", () => {
    const { models } = buildRegistry({ ...allOk(), openai: { ok: false, reason: "fetch-failed" } });
    const luna = models.find((m) => m.id === "openai-api/gpt-5.6-luna")!;
    expect(luna.livePricing).toBe(true);
    expect(luna.costPer1MInput).toBe(0.2);
  });

  it("serves the whole snapshot with fallback prices when every source failed", () => {
    const { models } = buildRegistry({
      openrouter: { ok: false, reason: "fetch-failed" },
      openai: { ok: false, reason: "fetch-failed" },
      anthropic: { ok: false, reason: "fetch-failed" },
      previous: null,
    });
    expect(models.map((m) => m.id)).toEqual(MODEL_SNAPSHOT.map((m) => m.id));
    expect(models.every((m) => m.livePricing === false)).toBe(true);
    expect(models.find((m) => m.id === "anthropic/claude-sonnet-5")?.costPer1MInput).toBe(2);
  });

  it("marks a live id nobody can price as unavailable rather than free", () => {
    const { models } = buildRegistry({ ...allOk(), openai: { ok: true, data: [...OPENAI_IDS, "gpt-7-astra"] } });
    const astra7 = models.find((m) => m.id === "openai-api/gpt-7-astra")!;
    expect(astra7).toMatchObject({ name: "GPT-7 Astra", costPer1MInput: 0, costPer1MOutput: 0, livePricing: false });
  });

  it("warns when a fetched group ranks fewer than two models (naming drift)", () => {
    const { warnings } = buildRegistry({ ...allOk(), openai: { ok: true, data: ["gpt-6-astra", "gpt-4o"] } });
    expect(warnings.some((w) => w.startsWith("openai: only 1 text model"))).toBe(true);
  });

  it("keeps the snapshot's fallback prices equal to the recorded feed", () => {
    const feedById = new Map(OPENROUTER_FEED.map((m) => [m.id, m]));
    let checked = 0;
    for (const m of catalogModels()) {
      const twin = feedById.get(priceKeyFor(m.id));
      if (!twin) continue;
      checked++;
      expect(m.fallbackInput, m.id).toBe(round3(Number(twin.pricing!.prompt) * 1e6));
      expect(m.fallbackOutput, m.id).toBe(round3(Number(twin.pricing!.completion) * 1e6));
    }
    expect(checked).toBe(29);
  });
});

describe("fetchRegistrySources", () => {
  function recordingFetch() {
    const urls: string[] = [];
    const headers: Record<string, Record<string, string>> = {};
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      headers[url] = Object.fromEntries(new Headers(init?.headers).entries());
      if (url.startsWith("https://openrouter.ai/")) return feedResponses.openrouter();
      if (url.startsWith("https://api.openai.com/")) return feedResponses.openai();
      if (url.startsWith("https://api.anthropic.com/")) return feedResponses.anthropic();
      throw new Error(`unexpected ${url}`);
    }) as typeof fetch;
    return { fetchImpl, urls, headers };
  }

  it("fetches all three lists with the right auth headers when every key is set", async () => {
    const f = recordingFetch();
    const sources = await fetchRegistrySources({ openrouter: "or", openai: "oa", anthropic: "an" }, f.fetchImpl);
    expect(sources.openrouter.ok && sources.openrouter.data.length).toBe(OPENROUTER_FEED.length);
    expect(sources.openai).toEqual({ ok: true, data: OPENAI_IDS });
    expect(sources.anthropic.ok).toBe(true);
    expect(f.headers["https://api.openai.com/v1/models"]?.authorization).toBe("Bearer oa");
    const anthropicUrl = f.urls.find((u) => u.startsWith("https://api.anthropic.com/"))!;
    expect(anthropicUrl).toBe("https://api.anthropic.com/v1/models?limit=1000");
    expect(f.headers[anthropicUrl]?.["x-api-key"]).toBe("an");
    expect(f.headers[anthropicUrl]?.["anthropic-version"]).toBe("2023-06-01");
  });

  it("skips a vendor entirely when its key is missing", async () => {
    const f = recordingFetch();
    const sources = await fetchRegistrySources({ openrouter: "or" }, f.fetchImpl);
    expect(sources.openai).toEqual({ ok: false, reason: "no-key" });
    expect(sources.anthropic).toEqual({ ok: false, reason: "no-key" });
    expect(f.urls.some((u) => u.includes("api.openai.com") || u.includes("api.anthropic.com"))).toBe(false);
  });

  it("reports a failed fetch without throwing", async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      if (String(input).startsWith("https://api.openai.com/")) return new Response("nope", { status: 500 });
      if (String(input).startsWith("https://openrouter.ai/")) return feedResponses.openrouter();
      return feedResponses.anthropic();
    }) as typeof fetch;
    const sources = await fetchRegistrySources({ openrouter: "or", openai: "oa", anthropic: "an" }, fetchImpl);
    expect(sources.openai).toEqual({ ok: false, reason: "fetch-failed" });
    expect(sources.openrouter.ok).toBe(true);
  });
});
```

- [ ] **Step 6: Run the new tests to verify they fail**

Run from `apps/worker`: `npx vitest run test/model-catalog.test.ts test/model-registry.test.ts`
Expected: FAIL (the catalogue exports do not exist yet / registry exports missing).

- [ ] **Step 7: Rewrite the registry**

Replace the whole of `apps/worker/src/services/model-registry.ts` with:

```ts
/**
 * Live model registry for the developer AI tools.
 *
 * Three text groups (OpenRouter, OpenAI API, Anthropic API) plus the curated
 * OpenRouter image group. Each vendor list is fetched live and ranked by rule
 * (spec 2026-09-12 section 3.2), every entry is priced from OpenRouter's public
 * feed (direct ids through their OpenRouter twin), and the result is cached in
 * KV for an hour. Per group, a failed fetch keeps the group from the last good
 * build; with none, the snapshot in @repo/utils is used. A missing platform
 * key hides that direct group.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import type { AIModel, TextEffort } from "@repo/types";
import {
  catalogModels,
  fallbackPriceFor,
  ROUTE_LABELS,
  VENDOR_ORDER,
  vendorLabel,
  DEFAULT_TEXT_MODEL_ID,
  type ModelKind,
  type ModelRoute,
} from "@repo/utils";
import { parseModelId, priceTwin, type ProviderKeys } from "@repo/llm";

export type { TextEffort };

/** Default model for the theme generator (site pipeline default lives in shops.ts). */
export const DEFAULT_THEME_MODEL = "anthropic/claude-sonnet-5";

export const MODELS_KV_KEY = "ai:models:v3";
/** Last successful build, no expiry: the per-group fallback when a vendor fetch fails. */
export const MODELS_LAST_GOOD_KV_KEY = "ai:models:v3:last";
const MODELS_KV_TTL = 3600; // 1h — pricing moves slowly; avoids hammering three catalogues
const DEGRADED_KV_TTL = 60; // feed down: retry soon, but not on every request
const FETCH_TIMEOUT_MS = 10_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const ALL_EFFORTS: TextEffort[] = ["low", "medium", "high"];
/** OpenRouter ids that stay listed even when the ranking would drop them. */
const PINNED_OPENROUTER_TEXT_IDS = [DEFAULT_TEXT_MODEL_ID, DEFAULT_THEME_MODEL];

export interface OpenRouterFeedModel {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  supported_parameters?: string[];
  architecture?: { output_modalities?: string[] };
}

export interface AnthropicListedModel {
  id: string;
  display_name?: string;
  capabilities?: { effort?: { supported?: string[] } | string[] };
}

export type GroupSource<T> = { ok: true; data: T } | { ok: false; reason: "no-key" | "fetch-failed" };

export interface RegistrySources {
  openrouter: GroupSource<OpenRouterFeedModel[]>;
  openai: GroupSource<string[]>;
  anthropic: GroupSource<AnthropicListedModel[]>;
}

export interface RegistryInputs extends RegistrySources {
  /** Last good build (from KV) used per group when that group's fetch failed. */
  previous: AIModel[] | null;
}

export interface RegistryBuild {
  models: AIModel[];
  warnings: string[];
}

// ─── Ranking rules ───────────────────────────────────────────────────────────

const OPENAI_TIER_RE = /^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)$/;
const OPENAI_TIER_ORDER = ["astra", "sol", "terra", "luna"];
const ANTHROPIC_FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];
/** Anthropic list ids: `claude-opus-5`, `claude-sonnet-4-5`, `claude-sonnet-4-5-20250929`. */
const ANTHROPIC_ID_RE = /^claude-(fable|opus|sonnet|haiku)-(\d+(?:[.-]\d+)?)(-\d{8})?$/;

function versionOf(s: string): number {
  const n = Number(s.replace("-", "."));
  return Number.isFinite(n) ? n : -1;
}

/** Dotted, undated form of an Anthropic id, used for ranking and price lookup; null when unrecognised. */
export function anthropicCanonical(vendorModel: string): string | null {
  const m = ANTHROPIC_ID_RE.exec(vendorModel);
  if (!m) return null;
  return `claude-${m[1]}-${m[2]!.replace("-", ".")}`;
}

/** Newest generation per tier, in astra, sol, terra, luna order. */
export function rankOpenAiIds(ids: string[]): string[] {
  const best = new Map<string, { id: string; version: number }>();
  for (const id of ids) {
    const m = OPENAI_TIER_RE.exec(id);
    if (!m) continue;
    const tier = m[2]!;
    const version = versionOf(m[1]!);
    const cur = best.get(tier);
    if (!cur || version > cur.version) best.set(tier, { id, version });
  }
  return OPENAI_TIER_ORDER.flatMap((t) => {
    const b = best.get(t);
    return b ? [b.id] : [];
  });
}

/** Highest version per family, in fable, opus, sonnet, haiku order; undated alias beats a dated snapshot. */
export function rankAnthropicIds(ids: string[]): string[] {
  const best = new Map<string, { id: string; version: number; dated: boolean }>();
  for (const id of ids) {
    const m = ANTHROPIC_ID_RE.exec(id);
    if (!m) continue;
    const family = m[1]!;
    const version = versionOf(m[2]!);
    const dated = Boolean(m[3]);
    const cur = best.get(family);
    if (!cur || version > cur.version || (version === cur.version && cur.dated && !dated)) {
      best.set(family, { id, version, dated });
    }
  }
  return ANTHROPIC_FAMILY_ORDER.flatMap((f) => {
    const b = best.get(f);
    return b ? [b.id] : [];
  });
}

/** Group 1 = version; optional group 2 = "-preview" (Google ships Pro as preview for months). */
interface FamilyRule {
  key: string;
  re: RegExp;
}

const OPENROUTER_FAMILY_TABLE: Array<{ vendor: string; families: FamilyRule[] }> = [
  {
    vendor: "google",
    families: [
      { key: "pro", re: /^gemini-(\d+(?:\.\d+)?)-pro(-preview)?$/ },
      { key: "flash", re: /^gemini-(\d+(?:\.\d+)?)-flash(-preview)?$/ },
      { key: "flash-lite", re: /^gemini-(\d+(?:\.\d+)?)-flash-lite(-preview)?$/ },
    ],
  },
  {
    vendor: "anthropic",
    families: [
      { key: "fable", re: /^claude-fable-(\d+(?:\.\d+)?)$/ },
      { key: "opus", re: /^claude-opus-(\d+(?:\.\d+)?)$/ },
      { key: "sonnet", re: /^claude-sonnet-(\d+(?:\.\d+)?)$/ },
      { key: "haiku", re: /^claude-haiku-(\d+(?:\.\d+)?)$/ },
    ],
  },
  {
    vendor: "openai",
    families: [
      { key: "astra", re: /^gpt-(\d+(?:\.\d+)?)-astra$/ },
      { key: "sol", re: /^gpt-(\d+(?:\.\d+)?)-sol$/ },
      { key: "terra", re: /^gpt-(\d+(?:\.\d+)?)-terra$/ },
      { key: "luna", re: /^gpt-(\d+(?:\.\d+)?)-luna$/ },
    ],
  },
  {
    vendor: "x-ai",
    families: [
      { key: "plain", re: /^grok-(\d+(?:\.\d+)?)$/ },
      { key: "multi-agent", re: /^grok-(\d+(?:\.\d+)?)-multi-agent$/ },
    ],
  },
  {
    vendor: "deepseek",
    families: [
      { key: "pro", re: /^deepseek-v(\d+(?:\.\d+)?)-pro$/ },
      { key: "flash", re: /^deepseek-v(\d+(?:\.\d+)?)-flash$/ },
    ],
  },
];

function isRankableText(m: OpenRouterFeedModel): boolean {
  if (m.id.includes(":")) return false;
  if (/-exp$/.test(m.id) || /-\d{4}$/.test(m.id)) return false;
  const out = m.architecture?.output_modalities;
  return !out || (out.length === 1 && out[0] === "text");
}

function pickFamily(vendorModels: string[], re: RegExp): string | null {
  let best: { id: string; version: number; preview: boolean } | null = null;
  for (const id of vendorModels) {
    const m = re.exec(id);
    if (!m) continue;
    const version = versionOf(m[1]!);
    const preview = Boolean(m[2]);
    if (!best || version > best.version || (version === best.version && best.preview && !preview)) {
      best = { id, version, preview };
    }
  }
  return best?.id ?? null;
}

/** Top tier per family per vendor, vendors in catalogue order, pinned defaults always kept. */
export function rankOpenRouterText(feed: OpenRouterFeedModel[]): string[] {
  const textIds = feed.filter(isRankableText).map((m) => m.id);
  const byVendor = new Map<string, string[]>();
  for (const rule of OPENROUTER_FAMILY_TABLE) {
    const prefix = `${rule.vendor}/`;
    const vendorModels = textIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    const picks: string[] = [];
    for (const fam of rule.families) {
      const p = pickFamily(vendorModels, fam.re);
      if (p) picks.push(prefix + p);
    }
    byVendor.set(rule.vendor, picks);
  }
  for (const pinned of [...PINNED_OPENROUTER_TEXT_IDS].reverse()) {
    const vendor = pinned.split("/")[0] ?? "";
    const list = byVendor.get(vendor) ?? [];
    if (!list.includes(pinned)) list.unshift(pinned);
    byVendor.set(vendor, list);
  }
  return VENDOR_ORDER.flatMap((v) => byVendor.get(v) ?? []);
}

// ─── Assembly ────────────────────────────────────────────────────────────────

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** "OpenAI: GPT-6 Astra" -> "GPT-6 Astra". */
function cleanFeedName(name: string | undefined): string | undefined {
  const n = name?.replace(/^[^:]+:\s*/, "").trim();
  return n || undefined;
}

function formatOpenAiName(vendorModel: string): string {
  const m = OPENAI_TIER_RE.exec(vendorModel);
  if (!m) return vendorModel;
  const tier = m[2]!;
  return `GPT-${m[1]} ${tier.charAt(0).toUpperCase()}${tier.slice(1)}`;
}

function anthropicEffortLevels(m: AnthropicListedModel): TextEffort[] {
  const eff = m.capabilities?.effort;
  if (eff === undefined) return ALL_EFFORTS;
  const supported = Array.isArray(eff) ? eff : eff.supported;
  if (!Array.isArray(supported)) return ALL_EFFORTS;
  return ALL_EFFORTS.filter((level) => supported.includes(level));
}

/** Feed key that carries a model's price: its OpenRouter slug, canonicalised for Anthropic ids. */
export function priceKeyFor(id: string): string {
  const { route, model } = parseModelId(id);
  if (route === "anthropic") return `anthropic/${anthropicCanonical(model) ?? model}`;
  return priceTwin(id);
}

/** Pure: join the three sources into the served list. Unit-tested against recorded lists. */
export function buildRegistry(inputs: RegistryInputs): RegistryBuild {
  const warnings: string[] = [];
  const feed = inputs.openrouter.ok ? inputs.openrouter.data : [];
  const feedById = new Map(feed.map((m) => [m.id, m]));
  const snapshot = catalogModels();
  const snapshotById = new Map(snapshot.map((m) => [m.id, m]));
  const previous = inputs.previous ?? [];

  const priceFor = (id: string): { input: number; output: number; live: boolean } => {
    const twin = feedById.get(priceKeyFor(id));
    const prompt = Number(twin?.pricing?.prompt);
    const completion = Number(twin?.pricing?.completion);
    if (twin && Number.isFinite(prompt) && Number.isFinite(completion)) {
      return { input: round3(prompt * 1e6), output: round3(completion * 1e6), live: true };
    }
    const fb = fallbackPriceFor(id);
    if (fb) return { input: fb.input, output: fb.output, live: false };
    return { input: 0, output: 0, live: false };
  };

  const make = (id: string, kind: ModelKind, name: string, effortLevels: TextEffort[]): AIModel => {
    const { route, model } = parseModelId(id);
    const vendor = route === "openrouter" ? (model.split("/")[0] ?? "") : route;
    const snap = snapshotById.get(id);
    const price = priceFor(id);
    return {
      id,
      name,
      kind,
      provider: route,
      providerLabel: ROUTE_LABELS[route],
      vendor,
      vendorLabel: vendorLabel(vendor),
      description: snap?.description ?? "",
      costPer1MInput: price.input,
      costPer1MOutput: price.output,
      supportsEffort: effortLevels.length > 0,
      effortLevels,
      recommended: snap?.recommended === true,
      livePricing: price.live,
    };
  };

  const fromSnapshot = (route: ModelRoute): AIModel[] =>
    snapshot
      .filter((m) => m.provider === route)
      .map((m) => make(m.id, m.kind, m.name, m.supportsEffort ? ALL_EFFORTS : []));

  const fallbackGroup = (route: ModelRoute): AIModel[] => {
    const prev = previous.filter((m) => m.provider === route);
    return prev.length > 0 ? prev : fromSnapshot(route);
  };

  const openRouterName = (id: string): string =>
    cleanFeedName(feedById.get(id)?.name) ?? snapshotById.get(id)?.name ?? (id.split("/")[1] ?? id);

  const openRouterEfforts = (id: string): TextEffort[] => {
    const f = feedById.get(id);
    if (f?.supported_parameters) return f.supported_parameters.includes("reasoning") ? ALL_EFFORTS : [];
    return snapshotById.get(id)?.supportsEffort === false ? [] : ALL_EFFORTS;
  };

  let openrouter: AIModel[];
  if (inputs.openrouter.ok) {
    openrouter = [
      ...rankOpenRouterText(feed).map((id) => make(id, "text", openRouterName(id), openRouterEfforts(id))),
      ...snapshot
        .filter((m) => m.provider === "openrouter" && m.kind === "image")
        .map((m) => make(m.id, "image", m.name, [])),
    ];
  } else {
    openrouter = fallbackGroup("openrouter");
  }

  let openai: AIModel[] = [];
  if (inputs.openai.ok) {
    openai = rankOpenAiIds(inputs.openai.data).map((vendorModel) => {
      const id = `openai-api/${vendorModel}`;
      const name =
        snapshotById.get(id)?.name ?? cleanFeedName(feedById.get(`openai/${vendorModel}`)?.name) ?? formatOpenAiName(vendorModel);
      return make(id, "text", name, ALL_EFFORTS);
    });
  } else if (inputs.openai.reason === "fetch-failed") {
    openai = fallbackGroup("openai");
  } else {
    warnings.push("openai: API key not configured; group hidden");
  }

  let anthropic: AIModel[] = [];
  if (inputs.anthropic.ok) {
    const listedById = new Map(inputs.anthropic.data.map((m) => [m.id, m]));
    anthropic = rankAnthropicIds(inputs.anthropic.data.map((m) => m.id)).map((vendorModel) => {
      const listed = listedById.get(vendorModel);
      const id = `anthropic-api/${vendorModel}`;
      const name =
        listed?.display_name?.trim() ||
        snapshotById.get(id)?.name ||
        cleanFeedName(feedById.get(priceKeyFor(id))?.name) ||
        vendorModel;
      return make(id, "text", name, listed ? anthropicEffortLevels(listed) : ALL_EFFORTS);
    });
  } else if (inputs.anthropic.reason === "fetch-failed") {
    anthropic = fallbackGroup("anthropic");
  } else {
    warnings.push("anthropic: API key not configured; group hidden");
  }

  const fetched: Array<[ModelRoute, AIModel[]]> = [
    ["openrouter", openrouter.filter((m) => m.kind === "text")],
    ["openai", openai],
    ["anthropic", anthropic],
  ];
  for (const [route, group] of fetched) {
    if (inputs[route].ok && group.length < 2) {
      warnings.push(`${route}: only ${group.length} text model(s) ranked; check vendor naming drift`);
    }
  }

  return { models: [...openrouter, ...openai, ...anthropic], warnings };
}

// ─── Fetching ────────────────────────────────────────────────────────────────

async function fetchOpenRouterFeed(doFetch: typeof fetch): Promise<GroupSource<OpenRouterFeedModel[]>> {
  try {
    const res = await doFetch(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: OpenRouterFeedModel[] };
    if (!Array.isArray(data.data) || data.data.length === 0) throw new Error("empty catalogue");
    return { ok: true, data: data.data };
  } catch (err) {
    console.warn("[model-registry] OpenRouter feed unavailable:", err);
    return { ok: false, reason: "fetch-failed" };
  }
}

async function fetchOpenAiIds(apiKey: string, doFetch: typeof fetch): Promise<GroupSource<string[]>> {
  try {
    const res = await doFetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { data?: Array<{ id?: unknown }> };
    const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
    if (ids.length === 0) throw new Error("empty list");
    return { ok: true, data: ids };
  } catch (err) {
    console.warn("[model-registry] OpenAI model list unavailable:", err);
    return { ok: false, reason: "fetch-failed" };
  }
}

async function fetchAnthropicModels(apiKey: string, doFetch: typeof fetch): Promise<GroupSource<AnthropicListedModel[]>> {
  try {
    const all: AnthropicListedModel[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = `${ANTHROPIC_MODELS_URL}?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}`;
      const res = await doFetch(url, {
        headers: { "x-api-key": apiKey, "anthropic-version": ANTHROPIC_VERSION, Accept: "application/json" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { data?: AnthropicListedModel[]; has_more?: boolean; last_id?: string | null };
      all.push(...(data.data ?? []).filter((m) => typeof m?.id === "string"));
      if (!data.has_more || !data.last_id) break;
      afterId = data.last_id;
    }
    if (all.length === 0) throw new Error("empty list");
    return { ok: true, data: all };
  } catch (err) {
    console.warn("[model-registry] Anthropic model list unavailable:", err);
    return { ok: false, reason: "fetch-failed" };
  }
}

/** The three lists in parallel, 10 s each; a missing key skips that vendor entirely. */
export async function fetchRegistrySources(keys: ProviderKeys, fetchImpl?: typeof fetch): Promise<RegistrySources> {
  const doFetch: typeof fetch = fetchImpl ?? ((input, init) => fetch(input, init));
  const [openrouter, openai, anthropic] = await Promise.all([
    fetchOpenRouterFeed(doFetch),
    keys.openai
      ? fetchOpenAiIds(keys.openai, doFetch)
      : Promise.resolve<GroupSource<string[]>>({ ok: false, reason: "no-key" }),
    keys.anthropic
      ? fetchAnthropicModels(keys.anthropic, doFetch)
      : Promise.resolve<GroupSource<AnthropicListedModel[]>>({ ok: false, reason: "no-key" }),
  ]);
  return { openrouter, openai, anthropic };
}

// ─── KV-cached entry points ──────────────────────────────────────────────────

async function readModels(kv: KVNamespace, key: string): Promise<AIModel[] | null> {
  const raw = await kv.get(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as AIModel[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/** The served list: KV cache first, else a fresh build (cached 1 h, or 60 s when the feed was down). */
export async function getLiveModels(kv: KVNamespace, keys: ProviderKeys): Promise<AIModel[]> {
  const cached = await readModels(kv, MODELS_KV_KEY);
  if (cached) return cached;

  const previous = await readModels(kv, MODELS_LAST_GOOD_KV_KEY);
  const sources = await fetchRegistrySources(keys);
  const { models, warnings } = buildRegistry({ ...sources, previous });
  for (const w of warnings) console.warn(`[model-registry] ${w}`);

  const json = JSON.stringify(models);
  await kv.put(MODELS_KV_KEY, json, { expirationTtl: sources.openrouter.ok ? MODELS_KV_TTL : DEGRADED_KV_TTL });
  if (sources.openrouter.ok) await kv.put(MODELS_LAST_GOOD_KV_KEY, json);
  return models;
}

/** Look up a listed model (validation and effort gating); kind-checked when asked. */
export async function getModel(
  kv: KVNamespace,
  keys: ProviderKeys,
  modelId: string,
  kind?: ModelKind,
): Promise<AIModel | undefined> {
  const id = modelId.trim();
  if (!id) return undefined;
  const models = await getLiveModels(kv, keys);
  return models.find((m) => m.id === id && (!kind || m.kind === kind));
}

export function providerKeysFromEnv(env: {
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
}): ProviderKeys {
  return {
    openrouter: env.OPENROUTER_API_KEY || undefined,
    openai: env.OPENAI_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
  };
}

export function parseTextEffort(v: unknown): TextEffort | undefined {
  return v === "low" || v === "medium" || v === "high" ? v : undefined;
}
```

- [ ] **Step 8: Run the two unit test files**

Run from `apps/worker`: `npx vitest run test/model-catalog.test.ts test/model-registry.test.ts`
Expected: both PASS. (The setup file seeds KV via `buildRegistry`, so this also proves the setup file loads.)

- [ ] **Step 9: Switch the theme generator and the AI routes to the async registry**

`apps/worker/src/services/ai-generator.ts`: change line 2 to:

```ts
import { getModel, type TextEffort } from "./model-registry.js";
import type { ProviderKeys } from "@repo/llm";
```

and replace the `generateShopTheme` head and the model lookup (lines 212 to 236) with:

```ts
export async function generateShopTheme(
  shopId: string,
  shopName: string,
  shopType: string,
  modelId: string,
  styleKeywords: string | undefined,
  effort: TextEffort | undefined,
  db: D1Database,
  kv: KVNamespace,
  keys: ProviderKeys,
  options: ThemeGenerationOptions = {}
): Promise<BrandConfig> {
  const model = await getModel(kv, keys, modelId, "text");
  if (!model) throw new Error(`Unknown model: ${modelId}`);

  const prompt = buildPrompt(shopName, shopType, styleKeywords, options.palette);

  let config: BrandConfig;

  try {
    // Only forward effort to models that accept it — OpenRouter rejects the
    // reasoning parameter on some non-reasoning providers.
    const effectiveEffort = model.supportsEffort ? effort : undefined;
    config = await callOpenRouter(modelId, prompt, keys.openrouter ?? "", effectiveEffort);
  } catch (err) {
    console.error(`[AI Generator] ${model.provider} call failed, using fallback:`, err);
    config = defaultTheme(shopName, shopType);
  }
```

(The rest of the function is unchanged. Task 5 replaces `callOpenRouter`.)

`apps/worker/src/routes/ai.ts`: replace the import block at lines 13 to 17 with:

```ts
import {
  DEFAULT_THEME_MODEL,
  getLiveModels,
  parseTextEffort,
  providerKeysFromEnv,
} from "../services/model-registry.js";
```

replace the `/models` handler (lines 50 to 54) with:

```ts
// ─── GET /api/ai/models — three provider groups with live pricing (KV-cached 1 h) ───

ai.get("/models", async (c) => {
  return c.json({ success: true, data: await getLiveModels(c.env.KV, providerKeysFromEnv(c.env)) });
});
```

and in the three `generateShopTheme(...)` calls (generate-theme at line 113, compare at lines 189 and 201) replace the argument `c.env.OPENROUTER_API_KEY,` with `providerKeysFromEnv(c.env),`.

- [ ] **Step 10: Validate model ids against the live registry in the shop routes**

`apps/worker/src/routes/shops.ts`:

Imports: remove `findCatalogModel,` from the `@repo/utils` import (line 33) and change line 44 to:

```ts
import { getLiveModels, parseTextEffort, providerKeysFromEnv } from "../services/model-registry.js";
```

Add this helper right after the imports (before the first route definition):

```ts
/** `listed(id, kind)` against the live registry (KV-cached); one read per request. */
async function modelLister(c: Context<{ Bindings: Bindings }>): Promise<(id: string, kind: "text" | "image") => boolean> {
  const registry = await getLiveModels(c.env.KV, providerKeysFromEnv(c.env));
  return (id, kind) => registry.some((m) => m.id === id && m.kind === kind);
}
```

Settings-save (lines 702 to 708): replace

```ts
  const textModelIn = typeof body.text_model === "string" ? body.text_model.trim() : "";
  if (textModelIn && !findCatalogModel(textModelIn, "text")) {
    return c.json({ success: false, error: `Unknown text model: ${textModelIn}` }, 400);
  }
  const imageModelIn = typeof body.image_model === "string" ? body.image_model.trim() : "";
  if (imageModelIn && !findCatalogModel(imageModelIn, "image")) {
```

with

```ts
  const listed = await modelLister(c);
  const textModelIn = typeof body.text_model === "string" ? body.text_model.trim() : "";
  if (textModelIn && !listed(textModelIn, "text")) {
    return c.json({ success: false, error: `Unknown text model: ${textModelIn}` }, 400);
  }
  const imageModelIn = typeof body.image_model === "string" ? body.image_model.trim() : "";
  if (imageModelIn && !listed(imageModelIn, "image")) {
```

Generate-image (lines 800 to 803): replace

```ts
  const imageModelIn = typeof imageModelRaw === "string" ? imageModelRaw.trim() : "";
  if (imageModelIn && !findCatalogModel(imageModelIn, "image")) {
```

with

```ts
  const imageModelIn = typeof imageModelRaw === "string" ? imageModelRaw.trim() : "";
  if (imageModelIn && !(await modelLister(c))(imageModelIn, "image")) {
```

Generate-site validation (lines 1173 to 1181): replace

```ts
  const bodyText = typeof body.text_model === "string" ? body.text_model.trim() : "";
  if (bodyText && !findCatalogModel(bodyText, "text")) {
    return c.json({ success: false, error: `Unknown text model: ${bodyText}` }, 400);
  }
  const bodyImage = typeof body.image_model === "string" ? body.image_model.trim() : "";
  if (bodyImage && !findCatalogModel(bodyImage, "image")) {
```

with

```ts
  const listed = await modelLister(c);
  const bodyText = typeof body.text_model === "string" ? body.text_model.trim() : "";
  if (bodyText && !listed(bodyText, "text")) {
    return c.json({ success: false, error: `Unknown text model: ${bodyText}` }, 400);
  }
  const bodyImage = typeof body.image_model === "string" ? body.image_model.trim() : "";
  if (bodyImage && !listed(bodyImage, "image")) {
```

Generate-site degrade (lines 1250 to 1263): replace

```ts
    const storedText = settingsKv.text_model?.trim() ?? "";
    const text_model =
      bodyText ||
      (storedText && findCatalogModel(storedText, "text") ? storedText : DEFAULT_TEXT_MODEL_ID);
```

with

```ts
    const storedText = settingsKv.text_model?.trim() ?? "";
    const storedTextListed = Boolean(storedText) && listed(storedText, "text");
    if (!bodyText && storedText && !storedTextListed) {
      console.warn(`[generate-site] stored text model ${storedText} is no longer listed; using ${DEFAULT_TEXT_MODEL_ID}`);
    }
    const text_model = bodyText || (storedTextListed ? storedText : DEFAULT_TEXT_MODEL_ID);
```

and

```ts
    const storedImage = settingsKv.image_model?.trim() ?? "";
    const image_model =
      bodyImage ||
      (storedImage && findCatalogModel(storedImage, "image")
        ? storedImage
        : DEFAULT_IMAGE_MODEL_ID);
```

with

```ts
    const storedImage = settingsKv.image_model?.trim() ?? "";
    const storedImageListed = Boolean(storedImage) && listed(storedImage, "image");
    if (!bodyImage && storedImage && !storedImageListed) {
      console.warn(`[generate-site] stored image model ${storedImage} is no longer listed; using ${DEFAULT_IMAGE_MODEL_ID}`);
    }
    const image_model = bodyImage || (storedImageListed ? storedImage : DEFAULT_IMAGE_MODEL_ID);
```

Run from `apps/worker`: `npx tsc --noEmit`
Expected: no errors. If `Context` is reported as unused or missing, it is already imported on line 1 (`import { Hono, type Context } from "hono";`).

- [ ] **Step 11: Update the route tests for the new registry**

Replace the whole of `apps/worker/test/ai-models.test.ts` with:

```ts
/**
 * /api/ai/models serves three provider groups with LIVE pricing when the
 * sources are reachable and the snapshot when they are not; the theme
 * generator forwards a validated reasoning effort and rejects garbage.
 *
 * The worker is dispatched in-isolate (direct import), so stubbing
 * globalThis.fetch intercepts every outbound call. Each test deletes the KV
 * cache the setup file seeded so the refresh path actually runs.
 */
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";
import { getLiveModels, MODELS_KV_KEY, MODELS_LAST_GOOD_KV_KEY } from "../src/services/model-registry";
import { feedResponses } from "./fixtures/model-feeds";

const originalFetch = globalThis.fetch;

type FetchStub = (url: string, init?: RequestInit) => Promise<Response> | null;
let stub: FetchStub | null = null;

/** The three list endpoints from the recorded fixtures; `down` makes them all throw. */
function listStub(opts: { down?: boolean } = {}): FetchStub {
  return (url) => {
    const isList =
      url.startsWith("https://openrouter.ai/api/v1/models") ||
      url.startsWith("https://api.openai.com/v1/models") ||
      url.startsWith("https://api.anthropic.com/v1/models");
    if (!isList) return null;
    // Throw synchronously: the async fetch wrapper turns this into its own
    // rejection, which the handler awaits — a detached Promise.reject()
    // here would trip workerd's unhandled-rejection detector.
    if (opts.down) throw new Error("network down");
    if (url.startsWith("https://openrouter.ai/")) return Promise.resolve(feedResponses.openrouter());
    if (url.startsWith("https://api.openai.com/")) return Promise.resolve(feedResponses.openai());
    return Promise.resolve(feedResponses.anthropic());
  };
}

function compose(...stubs: FetchStub[]): FetchStub {
  return (url, init) => {
    for (const s of stubs) {
      const r = s(url, init);
      if (r) return r;
    }
    return null;
  };
}

beforeEach(async () => {
  await env.KV.delete(MODELS_KV_KEY);
  await env.KV.delete(MODELS_LAST_GOOD_KV_KEY);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const handled = stub?.(url, init);
    if (handled) return handled;
    return originalFetch(input as never, init as never);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  stub = null;
});

async function devToken(): Promise<string> {
  const userId = await seedUser("developer", null);
  return tokenFor(userId, "developer", null);
}

describe("GET /api/ai/models", () => {
  it("serves the three groups joined with live pricing", async () => {
    stub = listStub();

    const res = await dispatch("GET", "/api/ai/models", { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(29);

    const sonnet = body.data.find((m) => m.id === "anthropic/claude-sonnet-5")!;
    expect(sonnet.provider).toBe("openrouter");
    expect(sonnet.vendor).toBe("anthropic");
    expect(sonnet.costPer1MInput).toBe(2);
    expect(sonnet.costPer1MOutput).toBe(10);
    expect(sonnet.livePricing).toBe(true);
    expect(sonnet.recommended).toBe(true);

    const astra = body.data.find((m) => m.id === "openai-api/gpt-6-astra")!;
    expect(astra.provider).toBe("openai");
    expect(astra.providerLabel).toBe("OpenAI API");
    expect(astra.costPer1MInput).toBe(10);
    expect(astra.livePricing).toBe(true);

    const fable = body.data.find((m) => m.id === "anthropic-api/claude-fable-5.1")!;
    expect(fable.provider).toBe("anthropic");
    expect(fable.effortLevels).toEqual(["low", "medium", "high"]);

    // The refresh wrote both cache keys.
    expect(await env.KV.get(MODELS_KV_KEY)).not.toBeNull();
    expect(await env.KV.get(MODELS_LAST_GOOD_KV_KEY)).not.toBeNull();
  });

  it("serves the snapshot when every source is unreachable and does not keep it for long", async () => {
    stub = listStub({ down: true });

    const res = await dispatch("GET", "/api/ai/models", { headers: authHeaders(await devToken()) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(29);
    expect(body.data.every((m) => m.livePricing === false)).toBe(true);
    for (const m of body.data) {
      expect(typeof m.costPer1MInput).toBe("number");
      expect(typeof m.costPer1MOutput).toBe("number");
      expect(typeof m.providerLabel).toBe("string");
      expect(typeof m.vendorLabel).toBe("string");
      expect(typeof m.supportsEffort).toBe("boolean");
      expect(Array.isArray(m.effortLevels)).toBe(true);
    }
    // Degraded build: served, but the last-good copy is not overwritten.
    expect(await env.KV.get(MODELS_LAST_GOOD_KV_KEY)).toBeNull();
  });

  it("hides a direct group when its platform key is missing", async () => {
    stub = listStub();
    const seen: string[] = [];
    const inner = stub;
    stub = (url, init) => {
      seen.push(url);
      return inner(url, init);
    };

    const models = await getLiveModels(env.KV, { openrouter: "k" });
    expect(models.some((m) => m.provider === "openai")).toBe(false);
    expect(models.some((m) => m.provider === "anthropic")).toBe(false);
    expect(models.some((m) => m.provider === "openrouter")).toBe(true);
    expect(seen.some((u) => u.includes("api.openai.com") || u.includes("api.anthropic.com"))).toBe(false);
  });

  it("serves the cached list without refetching", async () => {
    stub = listStub();
    await getLiveModels(env.KV, { openrouter: "k", openai: "k", anthropic: "k" });
    stub = listStub({ down: true });
    const models = await getLiveModels(env.KV, { openrouter: "k", openai: "k", anthropic: "k" });
    expect(models).toHaveLength(29);
    expect(models.some((m) => m.livePricing)).toBe(true);
  });
});

describe("POST /api/ai/generate-theme effort", () => {
  it("rejects an invalid effort with 400", async () => {
    stub = listStub();
    const shopId = await seedShop("Effort Validation Shop");
    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "anthropic/claude-sonnet-5", effort: "extreme" },
    });
    expect(res.status).toBe(400);
  });

  it("forwards a valid effort to OpenRouter as reasoning.effort", async () => {
    const shopId = await seedShop("Effort Forwarding Shop");
    let captured: Record<string, unknown> | null = null;

    const theme = {
      primaryColor: "#1A1A1A",
      accentColor: "#C9A84C",
      fontHeading: "Playfair Display",
      fontBody: "DM Sans",
      tagline: "t",
      heroHeadline: "h",
      heroSubheadline: "s",
      shortDescription: "d",
      ctaText: "Book now",
      aestheticKeywords: ["luxury"],
      servicesIntro: "i",
      trustStatement: "trust",
      urgencyText: "u",
    };

    stub = compose(listStub(), (url, init) => {
      if (url.startsWith("https://openrouter.ai/api/v1/chat/completions")) {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(theme) } }] }));
      }
      return null;
    });

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "anthropic/claude-sonnet-5", effort: "high", regenerate: true },
    });

    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.model).toBe("anthropic/claude-sonnet-5");
    expect(captured!.reasoning).toEqual({ effort: "high" });
    // Effort raises the completion budget so reasoning doesn't starve output.
    expect(captured!.max_tokens).toBe(8192);
  });
});
```

`apps/worker/test/model-validation.test.ts`: add these three tests inside the existing `describe("model id validation", ...)` block (after the "accepts a valid catalog model pair on settings save" test):

```ts
  it("accepts direct OpenAI API and Anthropic API ids on settings save", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "openai-api/gpt-6-astra" },
    });
    expect(res.status).toBe(200);
    const res2 = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "anthropic-api/claude-fable-5.1" },
    });
    expect(res2.status).toBe(200);
  });

  it("rejects a malformed direct id (empty model part)", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/settings`, {
      headers: devHeaders,
      body: { text_model: "openai-api/" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("Unknown text model");
  });

  it("forwards a direct id unchanged into the research queue payload", async () => {
    const { shopId, devHeaders } = await seedShopWithDev();
    const res = await dispatch("POST", `/api/shops/${shopId}/generate-site`, {
      headers: devHeaders,
      body: { skip_images: true, text_model: "anthropic-api/claude-opus-5", text_effort: "medium" },
    });
    expect(res.status).toBe(202);
    expect(captured!.text_model).toBe("anthropic-api/claude-opus-5");
    expect(captured!.text_effort).toBe("medium");
  });
```

Also update the file's header comment: replace `against the shared\n * MODEL_CATALOG` with `against the live\n * model registry (KV-seeded by test/setup-model-registry.ts)`.

`apps/worker/test/generate-site.model-effort.test.ts`: in the "drops an invalid effort but keeps the model" test replace both occurrences of `"x-ai/grok-4.3"` with `"x-ai/grok-4.6"` (Grok 4.3 is no longer a top tier).

- [ ] **Step 12: Run the whole worker suite and the monorepo type check**

Run from `apps/worker`: `npm test`
Expected: PASS across the suite (`ai-models`, `model-validation`, `generate-site.model-effort`, `ai-theme-apply`, `model-catalog`, `model-registry` included). If a test outside this list fails on `Unknown text model` or `Unknown image model`, it posts an id that is no longer top tier; switch it to the nearest id in `MODEL_SNAPSHOT` and note it in your report.

Run from the repo root: `npm run check-types`
Expected: every workspace passes, including `apps/web` (its `constants.ts` still compiles because `provider`/`providerLabel` still exist on the snapshot entries; the picker gets its Provider level in Task 10).

- [ ] **Step 13: Commit**

```bash
git add packages/utils/src/modelCatalog.ts packages/types/src/index.ts apps/worker/package.json package-lock.json apps/worker/src apps/worker/wrangler.toml apps/worker/vitest.config.mts apps/worker/test
git commit -m "feat(models): live three-provider model registry ranked by rule, priced from OpenRouter, validated everywhere" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 5: Theme generator calls through the shared client

**Files:**
- Modify: `apps/worker/src/services/ai-generator.ts:96-143` (delete `callOpenRouter`, add `callThemeModel`), and the call inside `generateShopTheme`
- Test: `apps/worker/test/ai-models.test.ts` (append a describe block)

**Interfaces:**
- Consumes (Task 2): `chatComplete`, `type ProviderKeys` from `@repo/llm`; (Task 4) `generateShopTheme(..., keys)`.
- Produces: nothing new; `generateShopTheme` now reaches OpenAI and Anthropic directly for direct ids.

- [ ] **Step 1: Write the failing tests for the direct routes**

Append to `apps/worker/test/ai-models.test.ts` (inside the file, after the existing describe blocks):

```ts
describe("POST /api/ai/generate-theme via direct routes", () => {
  const theme = {
    primaryColor: "#1A1A1A",
    accentColor: "#C9A84C",
    fontHeading: "Playfair Display",
    fontBody: "DM Sans",
    tagline: "t",
    heroHeadline: "h",
    heroSubheadline: "s",
    shortDescription: "d",
    ctaText: "Book now",
    aestheticKeywords: ["luxury"],
    servicesIntro: "i",
    trustStatement: "trust",
    urgencyText: "u",
  };

  it("calls Anthropic directly for an anthropic-api id and records that id as the shop's ai_model", async () => {
    const shopId = await seedShop("Direct Anthropic Shop");
    let captured: { headers: Record<string, string>; body: Record<string, unknown> } | null = null;

    stub = compose(listStub(), (url, init) => {
      if (url === "https://api.anthropic.com/v1/messages") {
        captured = {
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
        };
        return Promise.resolve(
          Response.json({ content: [{ type: "text", text: JSON.stringify(theme) }], usage: { input_tokens: 1, output_tokens: 2 } }),
        );
      }
      return null;
    });

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "anthropic-api/claude-sonnet-5", effort: "high", regenerate: true },
    });
    expect(res.status).toBe(200);
    expect(captured).not.toBeNull();
    expect(captured!.headers["x-api-key"]).toBe("test-anthropic-key");
    expect(captured!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured!.body.model).toBe("claude-sonnet-5");
    expect(captured!.body.output_config).toEqual({ effort: "high" });
    expect(captured!.body.max_tokens).toBe(8192);

    const row = await env.DB.prepare("SELECT ai_model FROM shops WHERE id = ?").bind(shopId).first<{ ai_model: string }>();
    expect(row?.ai_model).toBe("anthropic-api/claude-sonnet-5");
  });

  it("calls OpenAI directly for an openai-api id with reasoning_effort and max_completion_tokens", async () => {
    const shopId = await seedShop("Direct OpenAI Shop");
    let captured: Record<string, unknown> | null = null;

    stub = compose(listStub(), (url, init) => {
      if (url === "https://api.openai.com/v1/chat/completions") {
        captured = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return Promise.resolve(Response.json({ choices: [{ message: { content: JSON.stringify(theme) } }] }));
      }
      return null;
    });

    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "openai-api/gpt-6-astra", effort: "low", regenerate: true, preview: true },
    });
    expect(res.status).toBe(200);
    expect(captured!.model).toBe("gpt-6-astra");
    expect(captured!.reasoning_effort).toBe("low");
    expect(captured!.max_completion_tokens).toBe(2048);
    expect(captured!.response_format).toEqual({ type: "json_object" });
  });

  it("falls back to the default theme (HTTP 200) when the direct vendor errors", async () => {
    const shopId = await seedShop("Direct Failure Shop");
    stub = compose(listStub(), (url) => {
      if (url === "https://api.openai.com/v1/chat/completions") {
        return Promise.resolve(new Response("nope", { status: 401 }));
      }
      return null;
    });
    const res = await dispatch("POST", "/api/ai/generate-theme", {
      headers: authHeaders(await devToken()),
      body: { shop_id: shopId, model_id: "openai-api/gpt-5.6-luna", regenerate: true, preview: true },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { heroHeadline: string } };
    expect(body.data.heroHeadline).toBe("Welcome to Direct Failure Shop");
  });
});
```

- [ ] **Step 2: Run the file to verify the new tests fail**

Run from `apps/worker`: `npx vitest run test/ai-models.test.ts`
Expected: the three new tests FAIL (the generator still posts to OpenRouter, so `captured` stays null; the third still passes by accident of the fallback, which is fine).

- [ ] **Step 3: Replace `callOpenRouter` with `callThemeModel`**

In `apps/worker/src/services/ai-generator.ts` change the import lines to:

```ts
import { getModel, type TextEffort } from "./model-registry.js";
import { chatComplete, type ProviderKeys } from "@repo/llm";
```

Delete the block from the comment `// ─── OpenRouter API caller (all providers via the OpenAI-compatible API) ──────` through the end of `callOpenRouter` (keep `maxTokensForEffort`) and put this in its place:

```ts
// ─── Model caller (OpenRouter, OpenAI API or Anthropic API by id prefix) ─────

/** Reasoning tokens count against the completion budget on most providers, so
 *  give thinking models room to reason AND still emit the full JSON. */
function maxTokensForEffort(effort: TextEffort | undefined): number {
  if (effort === "high") return 8192;
  if (effort === "medium") return 4096;
  if (effort === "low") return 2048;
  return 1024;
}

const THEME_SYSTEM_PROMPT =
  "You are a brand designer and direct response copywriter. Return ONLY valid JSON, no markdown, no explanation, no code fences.";

async function callThemeModel(
  modelId: string,
  prompt: string,
  keys: ProviderKeys,
  effort?: TextEffort
): Promise<BrandConfig> {
  // A developer is waiting on this request: one retry, not three.
  const result = await chatComplete(
    {
      modelId,
      system: THEME_SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      effort,
      maxTokens: maxTokensForEffort(effort),
      jsonOnly: true,
      maxRetries: 1,
      appTitle: "Pivot Parlor",
    },
    keys
  );
  console.log(
    `[AI Generator] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
  );
  return JSON.parse(result.text) as BrandConfig;
}
```

and in `generateShopTheme` replace

```ts
    config = await callOpenRouter(modelId, prompt, keys.openrouter ?? "", effectiveEffort);
```

with

```ts
    config = await callThemeModel(modelId, prompt, keys, effectiveEffort);
```

- [ ] **Step 4: Run the worker suite**

Run from `apps/worker`: `npx vitest run test/ai-models.test.ts test/ai-theme-apply.test.ts` then `npm test`
Expected: all PASS. The pre-existing "forwards a valid effort to OpenRouter" test still sees `reasoning: { effort: "high" }` and `max_tokens: 8192` (the OpenRouter adapter keeps those field names).

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/services/ai-generator.ts apps/worker/test/ai-models.test.ts
git commit -m "feat(ai): theme generator calls OpenRouter, OpenAI or Anthropic through the shared client" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 6: Platform chatbot model endpoints, read routes exempt from the AI limiter

**Files:**
- Modify: `apps/worker/src/routes/ai.ts:34-54` (limiter ordering, `/models`, new `/chatbot-model` GET and POST)
- Test: `apps/worker/test/ai-chatbot-model.test.ts` (new)

**Interfaces:**
- Consumes (Task 4): `getModel`, `providerKeysFromEnv`, `getLiveModels`; `safeJsonParse` from `@repo/utils` (already imported in the file).
- Produces: `GET /api/ai/chatbot-model` → `{ success: true, data: { model_id: string | null, updated_at: string | null } }`; `POST /api/ai/chatbot-model` body `{ model_id }` → 200 `{ success: true, data: { model_id, updated_at } }`, 400 `model_id is required` / `Unknown text model: <id>`; KV key `platform:chatbot:model` = `{ model_id, updated_at }` (no TTL). Exported `CHATBOT_MODEL_KV_KEY`. Used by Task 9 (chatbot worker reads the key) and Task 12 (web card).

- [ ] **Step 1: Write the failing endpoint tests**

Create `apps/worker/test/ai-chatbot-model.test.ts`:

```ts
/**
 * Platform-wide chatbot model choice: developer-only, validated as a listed
 * text model, stored in KV under platform:chatbot:model. The read and
 * settings routes under /api/ai must not consume the 10/hour AI generation
 * budget (Decision 4 in the plan).
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { dispatch } from "./request";
import { seedShop, seedUser, tokenFor, authHeaders } from "./helpers";
import { CHATBOT_MODEL_KV_KEY } from "../src/routes/ai";

async function devHeaders(): Promise<Record<string, string>> {
  const userId = await seedUser("developer", null);
  return authHeaders(await tokenFor(userId, "developer", null));
}

describe("chatbot model endpoints", () => {
  it("reports nulls before anything is saved", async () => {
    const res = await dispatch("GET", "/api/ai/chatbot-model", { headers: await devHeaders() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { model_id: null, updated_at: null } });
  });

  it("saves a listed text model and reads it back", async () => {
    const headers = await devHeaders();
    const save = await dispatch("POST", "/api/ai/chatbot-model", {
      headers,
      body: { model_id: "openai-api/gpt-6-astra" },
    });
    expect(save.status).toBe(200);
    const saved = (await save.json()) as { data: { model_id: string; updated_at: string } };
    expect(saved.data.model_id).toBe("openai-api/gpt-6-astra");
    expect(Number.isNaN(Date.parse(saved.data.updated_at))).toBe(false);

    const stored = JSON.parse((await env.KV.get(CHATBOT_MODEL_KV_KEY)) ?? "{}") as Record<string, unknown>;
    expect(stored.model_id).toBe("openai-api/gpt-6-astra");

    const read = await dispatch("GET", "/api/ai/chatbot-model", { headers });
    expect(((await read.json()) as { data: { model_id: string } }).data.model_id).toBe("openai-api/gpt-6-astra");
  });

  it("rejects missing, unknown, wrong-kind and malformed ids with 400", async () => {
    const headers = await devHeaders();
    const cases: Array<[unknown, string]> = [
      [undefined, "model_id is required"],
      ["", "model_id is required"],
      ["qwen/qwen3.7-max", "Unknown text model: qwen/qwen3.7-max"],
      ["google/gemini-3.1-flash-image", "Unknown text model: google/gemini-3.1-flash-image"],
      ["openai-api/", "Unknown text model: openai-api/"],
    ];
    for (const [model_id, error] of cases) {
      const res = await dispatch("POST", "/api/ai/chatbot-model", {
        headers,
        body: model_id === undefined ? {} : { model_id },
      });
      expect(res.status, String(model_id)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect(await env.KV.get(CHATBOT_MODEL_KV_KEY)).toBeNull();
  });

  it("is developer-only", async () => {
    const shopId = await seedShop("Chatbot Model RBAC Shop");
    const adminId = await seedUser("admin", shopId);
    const headers = authHeaders(await tokenFor(adminId, "admin", shopId));
    expect((await dispatch("GET", "/api/ai/chatbot-model", { headers })).status).toBe(403);
    expect((await dispatch("POST", "/api/ai/chatbot-model", { headers, body: { model_id: "anthropic/claude-sonnet-5" } })).status).toBe(403);
  });
});

describe("AI read routes and the generation rate limit", () => {
  it("lets a developer read /models more than ten times an hour", async () => {
    const headers = await devHeaders();
    for (let i = 0; i < 12; i++) {
      const res = await dispatch("GET", "/api/ai/models", { headers });
      expect(res.status, `call ${i + 1}`).toBe(200);
    }
    const setting = await dispatch("POST", "/api/ai/chatbot-model", { headers, body: { model_id: "anthropic/claude-sonnet-5" } });
    expect(setting.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run from `apps/worker`: `npx vitest run test/ai-chatbot-model.test.ts`
Expected: FAIL (no `CHATBOT_MODEL_KV_KEY` export; 404s on the new routes; the 11th and 12th `/models` calls return 429).

- [ ] **Step 3: Reorder the router and add the endpoints**

In `apps/worker/src/routes/ai.ts` change the import from the registry to:

```ts
import {
  DEFAULT_THEME_MODEL,
  getLiveModels,
  getModel,
  parseTextEffort,
  providerKeysFromEnv,
} from "../services/model-registry.js";
```

and replace everything from `const ai = new Hono<{ Bindings: Bindings }>();` down to the end of the `/models` handler (the old lines 34 to 54) with:

```ts
const ai = new Hono<{ Bindings: Bindings }>();

// All AI routes require developer role
ai.use("*", authMiddleware, requireRole("developer"));

// ─── Read and settings routes: registered BEFORE the generation rate limiter ───
// Hono runs handlers in registration order and stops at the first response,
// so these cheap KV reads/writes never consume the 10/hour generation budget.

// GET /api/ai/models — three provider groups with live pricing (KV-cached 1 h)
ai.get("/models", async (c) => {
  return c.json({ success: true, data: await getLiveModels(c.env.KV, providerKeysFromEnv(c.env)) });
});

/** Platform-wide chatbot model choice: `{ model_id, updated_at }`, no expiry. */
export const CHATBOT_MODEL_KV_KEY = "platform:chatbot:model";

// GET /api/ai/chatbot-model — current platform-wide chatbot model (nulls when unset)
ai.get("/chatbot-model", async (c) => {
  const stored = safeJsonParse<{ model_id?: unknown; updated_at?: unknown }>(await c.env.KV.get(CHATBOT_MODEL_KV_KEY));
  return c.json({
    success: true,
    data: {
      model_id: typeof stored?.model_id === "string" ? stored.model_id : null,
      updated_at: typeof stored?.updated_at === "string" ? stored.updated_at : null,
    },
  });
});

// POST /api/ai/chatbot-model — body { model_id }; must be a listed text model
ai.post("/chatbot-model", async (c) => {
  const body = await c.req.json<{ model_id?: unknown }>().catch(() => ({}) as { model_id?: unknown });
  const modelId = typeof body.model_id === "string" ? body.model_id.trim() : "";
  if (!modelId) return c.json({ success: false, error: "model_id is required" }, 400);
  const model = await getModel(c.env.KV, providerKeysFromEnv(c.env), modelId, "text");
  if (!model) return c.json({ success: false, error: `Unknown text model: ${modelId}` }, 400);
  const record = { model_id: modelId, updated_at: new Date().toISOString() };
  await c.env.KV.put(CHATBOT_MODEL_KV_KEY, JSON.stringify(record));
  return c.json({ success: true, data: record });
});

// AI generation is expensive — cap per user (cost abuse brake, NFR-S4)
ai.use(
  "*",
  rateLimit({
    name: "ai",
    limit: 10,
    windowS: 3600,
    key: (c) => getUser(c)?.sub ?? clientIp(c),
  })
);
```

(The generate-theme, apply-theme and compare handlers that follow are unchanged and stay behind the limiter.)

- [ ] **Step 4: Run the tests**

Run from `apps/worker`: `npx vitest run test/ai-chatbot-model.test.ts test/ai-models.test.ts test/rate-limit.test.ts`
Expected: all PASS. If "lets a developer read /models more than ten times" still returns 429, Hono's ordering assumption in Decision 4 is wrong for this version: move the three read/settings routes to their own `Hono` sub-app mounted at `/api/ai` before `aiRouter` in `apps/worker/src/index.ts` (with the same `authMiddleware, requireRole("developer")` use) and report the change.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/routes/ai.ts apps/worker/test/ai-chatbot-model.test.ts
git commit -m "feat(ai): platform chatbot model endpoints; read routes exempt from the generation limiter" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 7: Research worker calls the shared client and rescues across routes

**Files:**
- Modify: `apps/workers/research/src/index.ts:4-23` (imports, `Env`), `:306-356` (delete `maxTokensForOpenRouterModel` and `openRouterJson`, add `researchJson`), `:537-583` (keys, attempts, call)
- Modify: `apps/workers/research/wrangler.toml:39-40` (secrets comment)

**Interfaces:**
- Consumes (Task 2): `chatComplete`, `type ProviderKeys` from `@repo/llm`.
- Produces: research spec generation for any route-qualified `text_model`; log line `[<jobId>] [pivot-parlor-research] llm route=<route> model=<model> in=<n> out=<n>`.

The research worker has no test suite (queue consumer; verified by type check, bundling and the rollout log check in spec section 8).

- [ ] **Step 1: Import the client and extend `Env`**

After the `design-spec` import (line 13) add:

```ts
import { chatComplete, type ProviderKeys } from "@repo/llm";
```

In `Env` after `OPENROUTER_API_KEY: string;` add:

```ts
  /** Direct-vendor keys; optional. A chosen direct model with no key falls back to the default model. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
```

- [ ] **Step 2: Replace the private OpenRouter caller**

Delete `maxTokensForOpenRouterModel` and `openRouterJson` (lines 306 to 356, from `function maxTokensForOpenRouterModel` through the closing `}` of `openRouterJson`) and insert:

```ts
/** One JSON-only completion through the shared client; HTTP retries and the
 *  effort retry live in the client, output validity is judged by the caller. */
async function researchJson(
  jobId: string,
  keys: ProviderKeys,
  model: string,
  system: string,
  user: string,
  effort?: TextEffort
): Promise<string> {
  const result = await chatComplete(
    {
      modelId: model,
      system,
      messages: [{ role: "user", content: user }],
      effort,
      maxTokens: 8000,
      jsonOnly: true,
      appTitle: "Pivot Parlor Research",
    },
    keys
  );
  console.log(
    `[${jobId}] [pivot-parlor-research] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
  );
  return result.text;
}
```

- [ ] **Step 3: Build the keys and shrink the attempt loop**

In `processOneMessage`, directly after the `OPENROUTER_API_KEY is not configured` guard block (after its closing `}` at line 547) add:

```ts
  const keys: ProviderKeys = {
    openrouter: apiKey,
    openai: env.OPENAI_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
  };
```

(Every key is optional except OpenRouter's, which the guard above already required.)

Replace the attempts comment and array (lines 556 to 566):

```ts
    // Model output is non-deterministic and providers rate-limit ("retry
    // shortly"), so: retry the chosen model with a growing pause between
    // attempts, then rescue the job with the default model — a temporarily
    // rate-limited upstream (e.g. a 429 on one vendor) must not sink the run.
    const attempts: { model: string; effort?: TextEffort }[] = [
      { model: input.text_model, effort: input.text_effort },
      { model: input.text_model, effort: input.text_effort },
      { model: input.text_model, effort: input.text_effort },
      ...(input.text_model !== DEFAULT_TEXT_MODEL ? [{ model: DEFAULT_TEXT_MODEL }] : []),
    ];
```

with:

```ts
    // HTTP retries (429/5xx, 3 s / 6 s / 9 s) and the effort retry live in the
    // shared client. This loop is for output validity (non-JSON, schema
    // failures): two tries of the chosen model, then rescue the job with the
    // default model on OpenRouter — a direct vendor with a missing key or an
    // outage must not sink the run.
    const attempts: { model: string; effort?: TextEffort }[] = [
      { model: input.text_model, effort: input.text_effort },
      { model: input.text_model, effort: input.text_effort },
      ...(input.text_model !== DEFAULT_TEXT_MODEL ? [{ model: DEFAULT_TEXT_MODEL }] : []),
    ];
```

and replace the call (line 583):

```ts
        rawText = await openRouterJson(apiKey, model, SYSTEM_PROMPT, userPrompt, effort);
```

with:

```ts
        rawText = await researchJson(jobId, keys, model, SYSTEM_PROMPT, userPrompt, effort);
```

- [ ] **Step 4: Document the secrets**

`apps/workers/research/wrangler.toml`, replace the last two lines:

```toml
# Secrets (wrangler secret put --name pivot-parlor-research):
#   OPENROUTER_API_KEY
#   OPENAI_API_KEY      (optional: direct OpenAI route for openai-api/* text models)
#   ANTHROPIC_API_KEY   (optional: direct Anthropic route for anthropic-api/* text models)
```

- [ ] **Step 5: Type-check and bundle**

```bash
cd apps/workers/research && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"
```

Expected: tsc silent; wrangler prints "--dry-run: exiting now." Also `grep -n "openRouterJson\|maxTokensForOpenRouterModel\|openrouter.ai" src/index.ts` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/research/src/index.ts apps/workers/research/wrangler.toml
git commit -m "feat(research): route the spec model through @repo/llm; rescue to the default model across routes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 8: Text worker calls the shared client with a default-model rescue

**Files:**
- Modify: `apps/workers/text/src/index.ts:4-12` (imports, `Env`), `:65-79` and `:93-127` (delete `maxTokensForOpenRouterModel` and `openRouterJson`, add `textJson`), `:216-221` (keys), `:272-290` (call with rescue)
- Modify: `apps/workers/text/wrangler.toml:30-31` (secrets comment)

**Interfaces:**
- Consumes (Task 2): `chatComplete`, `LlmError`, `type ProviderKeys` from `@repo/llm`.
- Produces: copy generation for any route-qualified `text_model`; log line `[<jobId>] [pivot-parlor-text] llm route=<route> model=<model> in=<n> out=<n>`.

- [ ] **Step 1: Import the client and extend `Env`**

After line 4 (`import type { D1Database, ... }`) add:

```ts
import { chatComplete, type ProviderKeys } from "@repo/llm";
```

In `Env` after `OPENROUTER_API_KEY: string;` add:

```ts
  /** Direct-vendor keys; optional. A chosen direct model with no key falls back to the default model. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
```

- [ ] **Step 2: Replace the private OpenRouter caller**

Delete `maxTokensForOpenRouterModel` (lines 73 to 78) and `openRouterJson` (lines 93 to 127) and insert, where `openRouterJson` was:

```ts
/** One JSON-only completion through the shared client (HTTP retries and the
 *  effort retry live there). */
async function textJson(
  jobId: string,
  keys: ProviderKeys,
  model: string,
  system: string,
  user: string,
  effort?: TextEffort
): Promise<string> {
  const result = await chatComplete(
    {
      modelId: model,
      system,
      messages: [{ role: "user", content: user }],
      effort,
      maxTokens: 8000,
      jsonOnly: true,
      appTitle: "Pivot Parlor Text",
    },
    keys
  );
  console.log(
    `[${jobId}] [pivot-parlor-text] llm route=${result.route} model=${result.model} in=${result.usage?.inputTokens ?? "?"} out=${result.usage?.outputTokens ?? "?"}`
  );
  return result.text;
}
```

- [ ] **Step 3: Build the keys and add the rescue**

In `processOne`, after the `OPENROUTER_API_KEY missing` guard (after its closing `}`) add:

```ts
  const keys: ProviderKeys = {
    openrouter: apiKey,
    openai: env.OPENAI_API_KEY || undefined,
    anthropic: env.ANTHROPIC_API_KEY || undefined,
  };
```

Replace the block from `const textModel = ...` through the `catch` that logs `OpenRouter failed` (lines 272 to 290):

```ts
  const textModel = msg.text_model?.trim() || research.text_model?.trim() || DEFAULT_TEXT_MODEL;
  const textEffort = msg.text_effort ?? research.text_effort;
  console.log(
    `[${jobId}] [pivot-parlor-text] calling OpenRouter model=${textModel}${textEffort ? ` effort=${textEffort}` : ""}`
  );

  let payload: TextKvPayload;
  try {
    const raw = await openRouterJson(apiKey, textModel, system, user, textEffort);
    const parsed: unknown = JSON.parse(raw);
    if (validateTextOut(parsed)) {
      parsed.services = padServices(research.shopType, parsed.services);
      parsed.completedAt = new Date().toISOString();
      payload = parsed;
    } else {
      console.warn(`[${jobId}] [pivot-parlor-text] model output invalid, using research fallback`);
      payload = fallbackFromResearch(research);
    }
  } catch (e) {
    console.error(`[${jobId}] [pivot-parlor-text] OpenRouter failed`, e);
    payload = fallbackFromResearch(research);
  }
```

with:

```ts
  const textModel = msg.text_model?.trim() || research.text_model?.trim() || DEFAULT_TEXT_MODEL;
  const textEffort = msg.text_effort ?? research.text_effort;
  console.log(
    `[${jobId}] [pivot-parlor-text] calling model=${textModel}${textEffort ? ` effort=${textEffort}` : ""}`
  );

  // Chosen model first; if it fails outright (missing direct key, outage)
  // rescue with the default model on OpenRouter before settling for the
  // research-derived copy.
  const attempts: { model: string; effort?: TextEffort }[] = [
    { model: textModel, effort: textEffort },
    ...(textModel !== DEFAULT_TEXT_MODEL ? [{ model: DEFAULT_TEXT_MODEL }] : []),
  ];

  let payload: TextKvPayload | null = null;
  for (const { model, effort } of attempts) {
    if (model !== textModel) {
      console.warn(`[${jobId}] [pivot-parlor-text] ${textModel} failed, falling back to default model ${model}`);
    }
    try {
      const raw = await textJson(jobId, keys, model, system, user, effort);
      const parsed: unknown = JSON.parse(raw);
      if (validateTextOut(parsed)) {
        parsed.services = padServices(research.shopType, parsed.services);
        parsed.completedAt = new Date().toISOString();
        payload = parsed;
      } else {
        console.warn(`[${jobId}] [pivot-parlor-text] model output invalid (model=${model})`);
      }
      break; // a reply came back; an invalid one is not retried on another model
    } catch (e) {
      console.error(`[${jobId}] [pivot-parlor-text] model call failed (model=${model})`, e);
    }
  }
  if (!payload) {
    console.warn(`[${jobId}] [pivot-parlor-text] using research fallback copy`);
    payload = fallbackFromResearch(research);
  }
```

Check that `payload` is declared with `let payload: TextKvPayload | null = null;` only once and that the code after this block (the palette override that follows) still reads `payload` as non-null. If TypeScript complains that `payload` may be null after the block, change the last statement to `const finalPayload: TextKvPayload = payload ?? fallbackFromResearch(research);` and rename later uses in that function from `payload` to `finalPayload`.

- [ ] **Step 4: Document the secrets**

`apps/workers/text/wrangler.toml`, replace the last two lines:

```toml
# Secrets:
#   OPENROUTER_API_KEY
#   OPENAI_API_KEY      (optional: direct OpenAI route for openai-api/* text models)
#   ANTHROPIC_API_KEY   (optional: direct Anthropic route for anthropic-api/* text models)
```

- [ ] **Step 5: Type-check and bundle**

```bash
cd apps/workers/text && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"
```

Expected: tsc silent; dry run exits 0; `grep -n "openRouterJson\|maxTokensForOpenRouterModel\|openrouter.ai" src/index.ts` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/text/src/index.ts apps/workers/text/wrangler.toml
git commit -m "feat(text): route the copy model through @repo/llm with a default-model rescue" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 9: Chatbot worker reads the platform choice and calls the shared client

**Files:**
- Create: `apps/workers/chatbot/src/model.ts`, `apps/workers/chatbot/src/llm.ts`, `apps/workers/chatbot/vitest.config.ts`
- Test: `apps/workers/chatbot/test/model.test.ts`
- Modify: `apps/workers/chatbot/src/types.ts` (Env keys; delete `OPENROUTER_MODEL`), `apps/workers/chatbot/src/index.ts:3-7, 201-255`, `apps/workers/chatbot/wrangler.toml:20-22`
- Delete: `apps/workers/chatbot/src/openrouter.ts`

**Interfaces:**
- Consumes (Task 2): `chatComplete`, `isValidModelId`, `type ProviderKeys`, `type ChatDeps` from `@repo/llm`; (Task 6) KV key `platform:chatbot:model`.
- Produces: `resolveChatbotModel(raw: string | null | undefined): { modelId: string; source: "platform" | "default"; reason?: string }`; `DEFAULT_CHATBOT_MODEL = "google/gemini-3.1-flash-lite-preview"`; `CHATBOT_MODEL_KV_KEY = "platform:chatbot:model"`; `generateReply(params, deps?): Promise<ChatCallResult>`.

- [ ] **Step 1: Write the failing tests**

`apps/workers/chatbot/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

// Plain node vitest: the tested modules are pure (model resolution) or take an
// injected fetch (the LLM call); the Hono app itself is exercised on staging.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
  },
});
```

`apps/workers/chatbot/test/model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { CHATBOT_MODEL_KV_KEY, DEFAULT_CHATBOT_MODEL, resolveChatbotModel } from "../src/model";
import { generateReply } from "../src/llm";

describe("resolveChatbotModel", () => {
  it("uses the platform choice when the KV record is valid", () => {
    expect(resolveChatbotModel(JSON.stringify({ model_id: "anthropic-api/claude-haiku-4.5", updated_at: "2026-09-12T00:00:00Z" }))).toEqual({
      modelId: "anthropic-api/claude-haiku-4.5",
      source: "platform",
    });
  });

  it("falls back to the code default when the record is absent, unparsable or malformed", () => {
    expect(resolveChatbotModel(null)).toEqual({ modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "unset" });
    expect(resolveChatbotModel(undefined).source).toBe("default");
    expect(resolveChatbotModel("not json")).toEqual({ modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "bad-json" });
    expect(resolveChatbotModel(JSON.stringify({ model_id: "" }))).toEqual({ modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "invalid-id" });
    expect(resolveChatbotModel(JSON.stringify({ model_id: "openai-api/" })).reason).toBe("invalid-id");
    expect(resolveChatbotModel(JSON.stringify({ nothing: true })).reason).toBe("invalid-id");
  });

  it("pins the key and default the API worker writes", () => {
    expect(CHATBOT_MODEL_KV_KEY).toBe("platform:chatbot:model");
    expect(DEFAULT_CHATBOT_MODEL).toBe("google/gemini-3.1-flash-lite-preview");
  });
});

describe("generateReply", () => {
  type Call = { url: string; body: Record<string, unknown> };
  function makeFetch(responses: Array<() => Response>) {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next();
    }) as typeof fetch;
    return { fetchImpl, calls };
  }
  const keys = { openrouter: "or", openai: "oa", anthropic: "an" };
  const params = {
    keys,
    systemPrompt: "You are the shop assistant.",
    history: [
      { role: "assistant" as const, content: "Hi there!" },
      { role: "user" as const, content: "Do you cut beards?" },
      { role: "system" as const, content: "should be dropped" },
    ],
    userMessage: "And prices?",
  };

  it("calls the chosen model with the system prompt, trimmed history and a 150-token budget, without effort", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => Response.json({ content: [{ type: "text", text: "From £12." }], usage: { input_tokens: 40, output_tokens: 5 } }),
    ]);
    const res = await generateReply({ ...params, modelId: "anthropic-api/claude-haiku-4.5" }, { fetch: fetchImpl });
    expect(res).toEqual({
      ok: true,
      content: "From £12.",
      model: "anthropic-api/claude-haiku-4.5",
      usage: { prompt_tokens: 40, completion_tokens: 5, total_tokens: 45 },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]!.body.system).toBe("You are the shop assistant.");
    expect(calls[0]!.body.max_tokens).toBe(150);
    expect(calls[0]!.body).not.toHaveProperty("output_config");
    expect(calls[0]!.body.messages).toEqual([
      { role: "user", content: "Do you cut beards?\n\nAnd prices?" },
    ]);
  });

  it("falls back to the default model once when the chosen model fails, and reports which model answered", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => new Response("nope", { status: 401 }),
      () => Response.json({ choices: [{ message: { content: "Sure." } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    ]);
    const res = await generateReply({ ...params, modelId: "openai-api/gpt-6-astra" }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, content: "Sure.", model: "google/gemini-3.1-flash-lite-preview" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
  });

  it("does not retry the default model against itself and reports ok:false", async () => {
    const { fetchImpl, calls } = makeFetch([() => new Response("boom", { status: 500 })]);
    const res = await generateReply({ ...params, modelId: "google/gemini-3.1-flash-lite-preview" }, { fetch: fetchImpl });
    expect(res).toEqual({ ok: false });
    expect(calls).toHaveLength(1);
  });

  it("falls back when the direct key is missing without calling the vendor", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => Response.json({ choices: [{ message: { content: "Sure." } }] }),
    ]);
    const res = await generateReply({ ...params, keys: { openrouter: "or" }, modelId: "openai-api/gpt-6-astra" }, { fetch: fetchImpl });
    expect(res).toMatchObject({ ok: true, model: "google/gemini-3.1-flash-lite-preview", usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
    expect(calls.map((c) => c.url)).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `apps/workers/chatbot`: `npx vitest run`
Expected: FAIL (modules `../src/model` and `../src/llm` do not exist).

- [ ] **Step 3: Implement model resolution and the LLM call**

`apps/workers/chatbot/src/model.ts`:

```ts
import { isValidModelId } from "@repo/llm";

/** Code default: today's chatbot model (Gemini Flash Lite via OpenRouter). */
export const DEFAULT_CHATBOT_MODEL = "google/gemini-3.1-flash-lite-preview";
/** Written by the API worker (POST /api/ai/chatbot-model): { model_id, updated_at }. */
export const CHATBOT_MODEL_KV_KEY = "platform:chatbot:model";

export interface ResolvedChatbotModel {
  modelId: string;
  source: "platform" | "default";
  reason?: "unset" | "bad-json" | "invalid-id";
}

/** The platform-wide choice from KV, or the code default with the reason. */
export function resolveChatbotModel(raw: string | null | undefined): ResolvedChatbotModel {
  if (!raw) return { modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "unset" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "bad-json" };
  }
  const id =
    parsed && typeof parsed === "object" && typeof (parsed as { model_id?: unknown }).model_id === "string"
      ? (parsed as { model_id: string }).model_id.trim()
      : "";
  if (!id || !isValidModelId(id)) return { modelId: DEFAULT_CHATBOT_MODEL, source: "default", reason: "invalid-id" };
  return { modelId: id, source: "platform" };
}
```

`apps/workers/chatbot/src/llm.ts`:

```ts
import { chatComplete, type ChatDeps, type ProviderKeys } from "@repo/llm";
import { DEFAULT_CHATBOT_MODEL } from "./model";

export type HistoryMessage = { role: "user" | "assistant" | "system"; content: string };

export type ChatCallResult =
  | {
      ok: true;
      content: string;
      /** Route-qualified id that actually answered (chosen model or the default rescue). */
      model: string;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }
  | { ok: false };

/**
 * One reply for the shop chatbot. The chosen model is tried once (a visitor
 * is waiting, so no HTTP back-off); if it fails for any reason (missing
 * direct key, vendor error) the code default is tried once. Effort is never
 * sent for the chatbot.
 */
export async function generateReply(
  params: {
    keys: ProviderKeys;
    modelId: string;
    systemPrompt: string;
    history: HistoryMessage[];
    userMessage: string;
  },
  deps: ChatDeps = {}
): Promise<ChatCallResult> {
  const messages = [
    ...params.history
      .slice(-10)
      .filter((m): m is { role: "user" | "assistant"; content: string } => m.role === "user" || m.role === "assistant"),
    { role: "user" as const, content: params.userMessage },
  ];
  const candidates = params.modelId === DEFAULT_CHATBOT_MODEL ? [params.modelId] : [params.modelId, DEFAULT_CHATBOT_MODEL];

  for (const modelId of candidates) {
    try {
      const r = await chatComplete(
        {
          modelId,
          system: params.systemPrompt,
          messages,
          maxTokens: 150,
          maxRetries: 0,
          appTitle: "Pivot Parlor Chatbot",
        },
        params.keys,
        deps
      );
      const prompt_tokens = r.usage?.inputTokens ?? 0;
      const completion_tokens = r.usage?.outputTokens ?? 0;
      console.log(`[chatbot] llm route=${r.route} model=${r.model} in=${prompt_tokens} out=${completion_tokens}`);
      return {
        ok: true,
        content: r.text,
        model: modelId,
        usage: { prompt_tokens, completion_tokens, total_tokens: prompt_tokens + completion_tokens },
      };
    } catch (err) {
      console.warn(`[chatbot] ${modelId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ok: false };
}
```

- [ ] **Step 4: Wire the handler, drop the old module**

`apps/workers/chatbot/src/types.ts`: replace the whole file with:

```ts
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";

export type Env = {
  DB: D1Database;
  KV: KVNamespace;
  OPENROUTER_API_KEY: string;
  /** Direct-vendor keys; optional. A platform choice on a route with no key falls back to the default model. */
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  ENVIRONMENT: string;
  PLATFORM_URL: string;
  TURNSTILE_SECRET_KEY?: string;
};

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };
```

Delete `apps/workers/chatbot/src/openrouter.ts` (`git rm apps/workers/chatbot/src/openrouter.ts`).

`apps/workers/chatbot/src/index.ts`: replace the imports at lines 3 to 7 with:

```ts
import type { ChatMessage } from "./types.js";
import type { Env } from "./types.js";
import { assertChatbotSchema } from "./ensure-schema.js";
import { generateReply } from "./llm.js";
import { CHATBOT_MODEL_KV_KEY, resolveChatbotModel } from "./model.js";
```

Replace the block from `let reply: string;` through the end of the `if (usedOpenRouter && usageForLog) { ... }` insert (old lines 201 to 255) with:

```ts
    let reply: string;
    let answeredBy: { model: string; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } } | null = null;

    if (isPlatformQuestion(visitorMessage)) {
      reply = platformReferralReply(shopSlug);
    } else {
      const ctx = await loadShopContext(c.env.DB, shop.id, shopSlug, shop.name, shop.type);
      let systemPrompt = appendPromoAwareness(buildSystemPrompt(ctx, platformUrl), ctx.promoActive);
      if (ctx.promoActive && /\b(discount|offer|promo|deal|code)\b/i.test(visitorMessage)) {
        systemPrompt = `${systemPrompt}\nThe visitor is asking about offers — reference the active promo if applicable.`;
      }

      // Platform-wide model choice (set on the developer dashboard); the code
      // default when unset or unreadable, logged once per request.
      const choice = resolveChatbotModel(await c.env.KV.get(CHATBOT_MODEL_KV_KEY));
      if (choice.source === "default" && choice.reason !== "unset") {
        console.warn(`[chatbot] platform model choice ignored (${choice.reason}); using ${choice.modelId}`);
      }

      const result = await generateReply({
        keys: {
          openrouter: c.env.OPENROUTER_API_KEY,
          openai: c.env.OPENAI_API_KEY || undefined,
          anthropic: c.env.ANTHROPIC_API_KEY || undefined,
        },
        modelId: choice.modelId,
        systemPrompt,
        history: priorMessages,
        userMessage: visitorMessage,
      });

      if (result.ok) {
        reply = result.content;
        answeredBy = { model: result.model, usage: result.usage };
      } else {
        reply = FALLBACK_REPLY;
      }
    }

    if (answeredBy) {
      const total = answeredBy.usage.total_tokens;
      const cost = total * 0.000000075;
      const logId = crypto.randomUUID();
      const jobRef = `public-chat:${logId}`;
      await c.env.DB.prepare(
        `INSERT INTO ai_usage_log (id, shop_id, worker_name, model, usage_type, input_tokens, output_tokens, total_tokens, estimated_cost_usd, job_id)
         VALUES (?, ?, 'pivot-parlor-chatbot', ?, 'chatbot', ?, ?, ?, ?, ?)`
      )
        .bind(
          logId,
          shop.id,
          answeredBy.model,
          answeredBy.usage.prompt_tokens,
          answeredBy.usage.completion_tokens,
          total,
          cost,
          jobRef
        )
        .run();
    }
```

`apps/workers/chatbot/wrangler.toml`: replace the trailing secrets comment with:

```toml
# Secrets:
#   OPENROUTER_API_KEY
#   OPENAI_API_KEY      (optional: direct OpenAI route when the platform chatbot model is openai-api/*)
#   ANTHROPIC_API_KEY   (optional: direct Anthropic route when the platform chatbot model is anthropic-api/*)
#   TURNSTILE_SECRET_KEY
```

- [ ] **Step 5: Test, type-check, bundle**

```bash
cd apps/workers/chatbot && npx vitest run && npx tsc --noEmit && npx wrangler deploy --dry-run --outdir "$(mktemp -d)"
```

Expected: 7 tests PASS; tsc silent; dry run exits 0; `grep -rn "OPENROUTER_MODEL\|callOpenRouter\|openrouter.js" src` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add apps/workers/chatbot
git commit -m "feat(chatbot): platform-wide model choice from KV via @repo/llm with default-model fallback" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

(The `git rm` of `openrouter.ts` is already staged.)

---

### Task 10: Web picker: Provider level, vendor sub-groups, effort levels

**Files:**
- Modify: `apps/web/app/components/dev-shops/modelPicker.helpers.ts` (rewrite)
- Modify: `apps/web/app/components/dev-shops/ModelPicker.tsx` (rewrite)
- Modify: `apps/web/app/components/dev-shops/constants.ts:1-29` (`staticPickerModels`)
- Test: `apps/web/app/components/dev-shops/modelPicker.helpers.test.ts` (rewrite), `apps/web/app/components/dev-shops/ModelPicker.test.tsx` (new)

**Interfaces:**
- Consumes (Task 4): `catalogModels`, `type ModelKind` from `@repo/utils`; `AIModel` from `@repo/types` is structurally a `PickerModel`.
- Produces: `PickerModel` (adds required `vendor`, `vendorLabel`; optional `effortLevels`), `PickerGroup`, `RouteGroup`, `groupByRoute`, `groupByVendor`, `defaultModelForGroup`, `effortLevelsFor`, `modelPriceLabel`, `ALL_EFFORT_LEVELS`; `ModelPicker` props unchanged (`label, models, value, onChange, effort?, onEffortChange?, disabled?`); `staticPickerModels(kind)` returns the new shape with `livePricing: false`. Select elements carry `data-testid` values `picker-provider`, `picker-vendor`, `picker-model`, `picker-effort`.

- [ ] **Step 1: Write the failing helper and component tests**

Replace the whole of `apps/web/app/components/dev-shops/modelPicker.helpers.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import {
  defaultModelForGroup,
  effortLevelsFor,
  groupByRoute,
  groupByVendor,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

const m = (
  id: string,
  provider: string,
  providerLabel: string,
  vendor: string,
  vendorLabel: string,
  extra: Partial<PickerModel> = {},
): PickerModel => ({
  id,
  name: id,
  provider,
  providerLabel,
  vendor,
  vendorLabel,
  costPer1MInput: 2,
  costPer1MOutput: 10,
  supportsEffort: true,
  ...extra,
});

const MODELS: PickerModel[] = [
  m("google/a", "openrouter", "OpenRouter", "google", "Google"),
  m("anthropic/x", "openrouter", "OpenRouter", "anthropic", "Anthropic", { recommended: true }),
  m("google/b", "openrouter", "OpenRouter", "google", "Google"),
  m("openai-api/p", "openai", "OpenAI API", "openai", "OpenAI"),
  m("anthropic-api/q", "anthropic", "Anthropic API", "anthropic", "Anthropic", { effortLevels: ["medium", "high"] }),
];

describe("groupByRoute", () => {
  it("groups by route in first-seen order with vendor sub-groups in first-seen order", () => {
    const routes = groupByRoute(MODELS);
    expect(routes.map((r) => r.id)).toEqual(["openrouter", "openai", "anthropic"]);
    expect(routes[0]!.label).toBe("OpenRouter");
    expect(routes[0]!.vendors.map((v) => v.id)).toEqual(["google", "anthropic"]);
    expect(routes[0]!.vendors[0]!.models.map((x) => x.id)).toEqual(["google/a", "google/b"]);
    expect(routes[1]!.vendors.map((v) => v.label)).toEqual(["OpenAI"]);
  });
});

describe("groupByVendor", () => {
  it("keeps model order inside each vendor", () => {
    const groups = groupByVendor(MODELS.filter((x) => x.provider === "openrouter"));
    expect(groups.map((g) => g.id)).toEqual(["google", "anthropic"]);
    expect(groups[0]!.models.map((x) => x.id)).toEqual(["google/a", "google/b"]);
  });
});

describe("defaultModelForGroup", () => {
  it("prefers the recommended model, else the first", () => {
    const routes = groupByRoute(MODELS);
    expect(defaultModelForGroup(routes[0]!)?.id).toBe("anthropic/x");
    expect(defaultModelForGroup(routes[1]!)?.id).toBe("openai-api/p");
    expect(defaultModelForGroup({ id: "empty", label: "Empty", models: [] })).toBeUndefined();
  });
});

describe("effortLevelsFor", () => {
  it("returns the reported subset, all three when unreported, none when unsupported or absent", () => {
    expect(effortLevelsFor(MODELS[4])).toEqual(["medium", "high"]);
    expect(effortLevelsFor(MODELS[0])).toEqual(["low", "medium", "high"]);
    expect(effortLevelsFor(m("z", "openrouter", "OpenRouter", "google", "Google", { supportsEffort: false }))).toEqual([]);
    expect(effortLevelsFor(m("z", "openrouter", "OpenRouter", "google", "Google", { effortLevels: [] }))).toEqual([]);
    expect(effortLevelsFor(undefined)).toEqual([]);
  });
});

describe("modelPriceLabel", () => {
  it("formats per-1M pricing", () => {
    expect(modelPriceLabel(m("a/b", "openrouter", "OpenRouter", "a", "A"))).toBe("$2/1M in · $10/1M out");
  });

  it("says so when nobody could price the model", () => {
    expect(
      modelPriceLabel(m("a/b", "openrouter", "OpenRouter", "a", "A", { costPer1MInput: 0, costPer1MOutput: 0, livePricing: false })),
    ).toBe("price unavailable");
    expect(
      modelPriceLabel(m("a/b", "openrouter", "OpenRouter", "a", "A", { costPer1MInput: 0, costPer1MOutput: 0, livePricing: true })),
    ).toBe("$0/1M in · $0/1M out");
  });
});
```

Create `apps/web/app/components/dev-shops/ModelPicker.test.tsx`:

```tsx
/** Provider -> (vendor) -> model -> effort cascade, rendered client-side so
 *  the select handlers run. */
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ModelPicker } from "./ModelPicker";
import type { PickerModel } from "./modelPicker.helpers";

const m = (
  id: string,
  name: string,
  provider: string,
  providerLabel: string,
  vendor: string,
  vendorLabel: string,
  extra: Partial<PickerModel> = {},
): PickerModel => ({
  id,
  name,
  provider,
  providerLabel,
  vendor,
  vendorLabel,
  costPer1MInput: 1,
  costPer1MOutput: 5,
  supportsEffort: true,
  ...extra,
});

const MODELS: PickerModel[] = [
  m("google/gemini-3.1-flash-lite-preview", "Gemini 3.1 Flash Lite", "openrouter", "OpenRouter", "google", "Google"),
  m("anthropic/claude-sonnet-5", "Claude Sonnet 5", "openrouter", "OpenRouter", "anthropic", "Anthropic", { recommended: true }),
  m("openai-api/gpt-6-astra", "GPT-6 Astra", "openai", "OpenAI API", "openai", "OpenAI"),
  m("openai-api/gpt-5.6-luna", "GPT-5.6 Luna", "openai", "OpenAI API", "openai", "OpenAI"),
  m("anthropic-api/claude-sonnet-5", "Claude Sonnet 5", "anthropic", "Anthropic API", "anthropic", "Anthropic", {
    effortLevels: ["medium", "high"],
  }),
];

function Harness({ initial, withEffort }: { initial: string; withEffort: boolean }) {
  const [value, setValue] = useState(initial);
  const [effort, setEffort] = useState("");
  return (
    <ModelPicker
      label="Text"
      models={MODELS}
      value={value}
      onChange={setValue}
      {...(withEffort ? { effort, onEffortChange: setEffort } : {})}
    />
  );
}

describe("ModelPicker", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
  });

  function render(initial: string, withEffort = true) {
    root = createRoot(container);
    act(() => root!.render(<Harness initial={initial} withEffort={withEffort} />));
  }

  const sel = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement | null;
  const optionValues = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.value);
  const optionLabels = (s: HTMLSelectElement) => Array.from(s.options).map((o) => o.textContent);

  function choose(s: HTMLSelectElement, value: string) {
    act(() => {
      s.value = value;
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("lists the three providers in order and shows the vendor step for OpenRouter", () => {
    render("google/gemini-3.1-flash-lite-preview");
    const provider = sel("picker-provider")!;
    expect(optionLabels(provider)).toEqual(["OpenRouter", "OpenAI API", "Anthropic API"]);
    expect(provider.value).toBe("openrouter");
    const vendor = sel("picker-vendor")!;
    expect(optionLabels(vendor)).toEqual(["Google", "Anthropic"]);
    expect(vendor.value).toBe("google");
    expect(optionValues(sel("picker-model")!)).toEqual(["google/gemini-3.1-flash-lite-preview"]);
  });

  it("switching to a direct provider removes the vendor step and picks that provider's first model", () => {
    render("google/gemini-3.1-flash-lite-preview");
    choose(sel("picker-provider")!, "openai");
    expect(sel("picker-vendor")).toBeNull();
    const model = sel("picker-model")!;
    expect(model.value).toBe("openai-api/gpt-6-astra");
    expect(optionValues(model)).toEqual(["openai-api/gpt-6-astra", "openai-api/gpt-5.6-luna"]);
  });

  it("switching back to OpenRouter picks the recommended model and its vendor", () => {
    render("openai-api/gpt-6-astra");
    expect(sel("picker-provider")!.value).toBe("openai");
    choose(sel("picker-provider")!, "openrouter");
    expect(sel("picker-model")!.value).toBe("anthropic/claude-sonnet-5");
    expect(sel("picker-vendor")!.value).toBe("anthropic");
  });

  it("changing the vendor picks that vendor's first model", () => {
    render("anthropic/claude-sonnet-5");
    choose(sel("picker-vendor")!, "google");
    expect(sel("picker-model")!.value).toBe("google/gemini-3.1-flash-lite-preview");
  });

  it("limits the effort options to the levels the model reports", () => {
    render("anthropic-api/claude-sonnet-5");
    expect(optionValues(sel("picker-effort")!)).toEqual(["", "medium", "high"]);
  });

  it("offers all three levels when the model supports effort without a reported list", () => {
    render("google/gemini-3.1-flash-lite-preview");
    expect(optionValues(sel("picker-effort")!)).toEqual(["", "low", "medium", "high"]);
  });

  it("hides the effort step when the caller does not handle effort", () => {
    render("google/gemini-3.1-flash-lite-preview", false);
    expect(sel("picker-effort")).toBeNull();
  });

  it("labels the model options with price", () => {
    render("openai-api/gpt-6-astra");
    expect(optionLabels(sel("picker-model")!)[0]).toBe("GPT-6 Astra · $1/1M in · $5/1M out");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `apps/web`: `npx vitest run app/components/dev-shops`
Expected: FAIL (`groupByRoute` etc. are not exported; `data-testid` selects missing).

- [ ] **Step 3: Rewrite the helpers**

Replace the whole of `apps/web/app/components/dev-shops/modelPicker.helpers.ts` with:

```ts
// Pure logic for the cascaded model picker (Provider -> vendor -> model ->
// effort), split from the component so grouping and labelling are
// unit-testable without rendering. `AIModel` from @repo/types satisfies
// PickerModel structurally; staticPickerModels() builds one from the snapshot.

export interface PickerModel {
  id: string;
  name: string;
  /** Route: "openrouter" | "openai" | "anthropic". */
  provider: string;
  providerLabel: string;
  /** Model maker: google, anthropic, openai, x-ai, deepseek. */
  vendor: string;
  vendorLabel: string;
  costPer1MInput: number;
  costPer1MOutput: number;
  supportsEffort: boolean;
  /** Effort levels the model accepts; absent means "all three" when supportsEffort. */
  effortLevels?: string[];
  recommended?: boolean;
  livePricing?: boolean;
}

export interface PickerGroup {
  id: string;
  label: string;
  models: PickerModel[];
}

export interface RouteGroup extends PickerGroup {
  vendors: PickerGroup[];
}

export const ALL_EFFORT_LEVELS = ["low", "medium", "high"];

function groupBy(models: PickerModel[], key: (m: PickerModel) => { id: string; label: string }): PickerGroup[] {
  const groups: PickerGroup[] = [];
  for (const model of models) {
    const k = key(model);
    let group = groups.find((g) => g.id === k.id);
    if (!group) {
      group = { id: k.id, label: k.label, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}

/** Group by vendor, preserving first-seen vendor and model order. */
export function groupByVendor(models: PickerModel[]): PickerGroup[] {
  return groupBy(models, (m) => ({ id: m.vendor, label: m.vendorLabel }));
}

/** Group by route (provider) in first-seen order, each with vendor sub-groups. */
export function groupByRoute(models: PickerModel[]): RouteGroup[] {
  return groupBy(models, (m) => ({ id: m.provider, label: m.providerLabel })).map((g) => ({
    ...g,
    vendors: groupByVendor(g.models),
  }));
}

export function modelPriceLabel(m: PickerModel): string {
  if (!m.livePricing && m.costPer1MInput === 0 && m.costPer1MOutput === 0) return "price unavailable";
  return `$${m.costPer1MInput}/1M in · $${m.costPer1MOutput}/1M out`;
}

/** A group change picks the group's recommended model, else its first. */
export function defaultModelForGroup(group: PickerGroup): PickerModel | undefined {
  return group.models.find((m) => m.recommended) ?? group.models[0];
}

/** Effort levels to offer for a model: the reported subset, all three when unreported, none when unsupported. */
export function effortLevelsFor(m: PickerModel | undefined): string[] {
  if (!m || !m.supportsEffort) return [];
  if (m.effortLevels === undefined) return ALL_EFFORT_LEVELS;
  return m.effortLevels.filter((level) => ALL_EFFORT_LEVELS.includes(level));
}
```

- [ ] **Step 4: Rewrite the component**

Replace the whole of `apps/web/app/components/dev-shops/ModelPicker.tsx` with:

```tsx
// Cascaded Provider -> vendor -> model -> effort picker. OpenRouter shows a
// vendor step; the direct providers (OpenAI API, Anthropic API) go straight to
// the model. Pass live models (from /api/ai/models) when available, else the
// static snapshot from staticPickerModels().
import type { ReactNode } from "react";
import { EFFORT_OPTIONS } from "./constants";
import {
  defaultModelForGroup,
  effortLevelsFor,
  groupByRoute,
  modelPriceLabel,
  type PickerModel,
} from "./modelPicker.helpers";

const SELECT_CLASS =
  "flex h-10 w-full rounded-lg border border-white/20 bg-white/5 px-3 text-sm text-white focus:outline-none focus:ring-2 focus:ring-gold";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-white/80">{label}</label>
      {children}
    </div>
  );
}

export function ModelPicker({
  label,
  models,
  value,
  onChange,
  effort,
  onEffortChange,
  disabled = false,
}: {
  label: string;
  models: PickerModel[];
  value: string;
  onChange: (id: string) => void;
  /** Current effort ("" = model decides). Omit both effort props to hide the effort select (image models, chatbot). */
  effort?: string;
  onEffortChange?: (effort: string) => void;
  disabled?: boolean;
}) {
  const routes = groupByRoute(models);
  const selected = models.find((m) => m.id === value);
  const routeId = selected?.provider ?? routes[0]?.id ?? "";
  const route = routes.find((r) => r.id === routeId);
  const showVendors = routeId === "openrouter" && (route?.vendors.length ?? 0) > 0;
  const vendorId = selected?.vendor ?? route?.vendors[0]?.id ?? "";
  const vendor = route?.vendors.find((v) => v.id === vendorId);
  const modelOptions = showVendors ? (vendor?.models ?? []) : (route?.models ?? []);
  const levels = effortLevelsFor(selected);
  const effortVisible = onEffortChange !== undefined && levels.length > 0;
  const effortOptions = EFFORT_OPTIONS.filter((o) => o.value === "" || levels.includes(o.value));

  function pick(next: PickerModel | undefined) {
    if (!next) return;
    onChange(next.id);
    onEffortChange?.("");
  }

  return (
    <div className="space-y-3">
      <Field label={`${label} provider`}>
        <select
          value={routeId}
          onChange={(e) => {
            const r = routes.find((g) => g.id === e.target.value);
            pick(r ? defaultModelForGroup(r) : undefined);
          }}
          disabled={disabled}
          className={SELECT_CLASS}
          data-testid="picker-provider"
        >
          {routes.map((r) => (
            <option key={r.id} value={r.id} className="bg-dark">
              {r.label}
            </option>
          ))}
        </select>
      </Field>
      {showVendors && (
        <Field label={`${label} vendor`}>
          <select
            value={vendorId}
            onChange={(e) => {
              const v = route?.vendors.find((g) => g.id === e.target.value);
              pick(v ? defaultModelForGroup(v) : undefined);
            }}
            disabled={disabled}
            className={SELECT_CLASS}
            data-testid="picker-vendor"
          >
            {route?.vendors.map((v) => (
              <option key={v.id} value={v.id} className="bg-dark">
                {v.label}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={`${label} model`}>
        <select
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            onEffortChange?.("");
          }}
          disabled={disabled}
          className={SELECT_CLASS}
          data-testid="picker-model"
        >
          {!selected && (
            <option value="" disabled className="bg-dark">
              Select a model
            </option>
          )}
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id} className="bg-dark">
              {m.name}
              {m.recommended ? " ★" : ""} · {modelPriceLabel(m)}
            </option>
          ))}
        </select>
      </Field>
      {effortVisible && (
        <Field label="Reasoning effort">
          <select
            value={effort ?? ""}
            onChange={(e) => onEffortChange?.(e.target.value)}
            disabled={disabled}
            className={SELECT_CLASS}
            data-testid="picker-effort"
          >
            {effortOptions.map((o) => (
              <option key={o.value} value={o.value} className="bg-dark">
                {o.label}
              </option>
            ))}
          </select>
        </Field>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Update the static snapshot mapper**

In `apps/web/app/components/dev-shops/constants.ts` replace the `staticPickerModels` function (lines 15 to 28) with:

```ts
/** Snapshot entries with fallback pricing, for pickers without a live-priced loader. */
export function staticPickerModels(kind: ModelKind): PickerModel[] {
  return catalogModels(kind).map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
    providerLabel: m.providerLabel,
    vendor: m.vendor,
    vendorLabel: m.vendorLabel,
    costPer1MInput: m.fallbackInput,
    costPer1MOutput: m.fallbackOutput,
    supportsEffort: m.supportsEffort,
    effortLevels: m.supportsEffort ? ["low", "medium", "high"] : [],
    recommended: m.recommended,
    livePricing: false,
  }));
}
```

and change the `EFFORT_OPTIONS` comment to `/** Reasoning-effort choices; the picker filters them to the levels a model reports. */`.

- [ ] **Step 6: Run the web tests, type check and lint**

Run from `apps/web`: `npx vitest run app/components/dev-shops` then `npx tsc` then `npm run lint`
Expected: all PASS; tsc silent; eslint zero warnings. `dev.ai-deploy.tsx` passes `AIModel[]` into the picker unchanged (the type now carries `vendor`, `vendorLabel`, `effortLevels`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/components/dev-shops
git commit -m "feat(web): model picker gains a Provider level with vendor sub-groups and reported effort levels" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 11: Shop page picks from live models with a snapshot fallback

**Files:**
- Modify: `apps/web/app/components/dev-shops/constants.ts` (add `pickerModelsFrom`)
- Test: `apps/web/app/components/dev-shops/constants.test.ts` (new)
- Modify: `apps/web/app/routes/dev.shops.$shopId.tsx:1-8, 71-79, 81-99` (loader fetches models; outlet context)
- Modify: `apps/web/app/routes/dev.shops.$shopId._index.tsx:15-33, 289-303` (use live models; caption)

**Interfaces:**
- Consumes (Task 10): `PickerModel`, `staticPickerModels`; `AIModel` from `@repo/types`; `createApiClient` from `~/lib/api`.
- Produces: `pickerModelsFrom(live: AIModel[] | null | undefined, kind: ModelKind): PickerModel[]`; outlet context field `models: AIModel[] | null` on the shop detail layout (`OutletCtx`).

- [ ] **Step 1: Write the failing helper test**

Create `apps/web/app/components/dev-shops/constants.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import type { AIModel } from "@repo/types";
import { pickerModelsFrom, staticPickerModels } from "./constants";

const live: AIModel = {
  id: "openai-api/gpt-6-astra",
  name: "GPT-6 Astra",
  kind: "text",
  provider: "openai",
  providerLabel: "OpenAI API",
  vendor: "openai",
  vendorLabel: "OpenAI",
  description: "",
  costPer1MInput: 10,
  costPer1MOutput: 50,
  supportsEffort: true,
  effortLevels: ["low", "medium", "high"],
  recommended: false,
  livePricing: true,
};

describe("pickerModelsFrom", () => {
  it("uses the live list filtered by kind when it has entries of that kind", () => {
    const out = pickerModelsFrom([live, { ...live, id: "google/gemini-3.1-flash-image", kind: "image" }], "text");
    expect(out.map((m) => m.id)).toEqual(["openai-api/gpt-6-astra"]);
    expect(out[0]!.livePricing).toBe(true);
  });

  it("falls back to the snapshot when the live list is missing, empty or lacks that kind", () => {
    const snapshotText = staticPickerModels("text").map((m) => m.id);
    expect(pickerModelsFrom(null, "text").map((m) => m.id)).toEqual(snapshotText);
    expect(pickerModelsFrom([], "text").map((m) => m.id)).toEqual(snapshotText);
    expect(pickerModelsFrom([live], "image").map((m) => m.id)).toEqual(staticPickerModels("image").map((m) => m.id));
    expect(pickerModelsFrom(null, "text").every((m) => m.livePricing === false)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `apps/web`: `npx vitest run app/components/dev-shops/constants.test.ts`
Expected: FAIL (`pickerModelsFrom` is not exported).

- [ ] **Step 3: Add the helper**

In `apps/web/app/components/dev-shops/constants.ts` add `import type { AIModel } from "@repo/types";` next to the other imports and append after `staticPickerModels`:

```ts
/** Live registry entries of one kind, else the snapshot (API unreachable or empty). */
export function pickerModelsFrom(live: AIModel[] | null | undefined, kind: ModelKind): PickerModel[] {
  const fromLive = (live ?? []).filter((m) => m.kind === kind);
  return fromLive.length > 0 ? fromLive : staticPickerModels(kind);
}
```

Run from `apps/web`: `npx vitest run app/components/dev-shops/constants.test.ts`
Expected: PASS.

- [ ] **Step 4: Load the live list in the shop detail layout**

`apps/web/app/routes/dev.shops.$shopId.tsx`: add `import type { AIModel } from "@repo/types";` after line 8, then in the loader after the `visuals` block (after line 76) add:

```ts
  // Live-priced model list for the generation pickers; null falls back to the
  // snapshot in the route (the API worker caches this for an hour).
  let models: AIModel[] | null = null;
  try {
    models = await api.get<AIModel[]>("/api/ai/models");
  } catch {
    models = null;
  }
```

change the return to:

```ts
  return json({ shop, apiUrl: env.API_URL, generationPrefs, ownerDetails, visuals, models });
```

and in the component change the destructure and the outlet:

```tsx
  const { shop, apiUrl, generationPrefs, ownerDetails, visuals, models } = useLoaderData<typeof loader>();
```

```tsx
      <Outlet context={{ shop, apiUrl, generationPrefs, ownerDetails, visuals, models }} />
```

- [ ] **Step 5: Use it in the index route**

`apps/web/app/routes/dev.shops.$shopId._index.tsx`:

Replace the import of `staticPickerModels` in the `constants` import (lines 15 to 20) with `pickerModelsFrom`:

```ts
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  REGEN_STEP_LABELS,
  pickerModelsFrom,
} from "~/components/dev-shops/constants";
```

Add `import type { AIModel } from "@repo/types";` next to the `Shop` type import, extend `OutletCtx`:

```ts
type OutletCtx = {
  shop: Shop;
  apiUrl: string;
  generationPrefs: DevGenerationPrefs;
  ownerDetails: DevShopOwnerDetails | null;
  visuals: VisualsData | null;
  models: AIModel[] | null;
};
```

and the destructure:

```ts
  const { shop, apiUrl, generationPrefs, ownerDetails, visuals, models } = useOutletContext<OutletCtx>();
  const textPickerModels = pickerModelsFrom(models, "text");
  const imagePickerModels = pickerModelsFrom(models, "image");
```

Replace the two pickers (lines 289 to 303) with:

```tsx
          <ModelPicker
            label="Text & research"
            models={textPickerModels}
            value={textModel}
            onChange={setTextModel}
            effort={textEffort}
            onEffortChange={setTextEffort}
            disabled={running}
          />
          <p className="-mt-1 text-xs text-white/50">
            {textPickerModels.some((m) => m.livePricing)
              ? "Live pricing, refreshed hourly."
              : "Price feed unreachable, showing last-known pricing."}
          </p>
          <ModelPicker
            label="Image"
            models={imagePickerModels}
            value={imageModel}
            onChange={setImageModel}
            disabled={running}
          />
```

- [ ] **Step 6: Type check, lint, tests**

Run from `apps/web`: `npx tsc && npm run lint && npx vitest run`
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/components/dev-shops/constants.ts apps/web/app/components/dev-shops/constants.test.ts "apps/web/app/routes/dev.shops.\$shopId.tsx" "apps/web/app/routes/dev.shops.\$shopId._index.tsx"
git commit -m "feat(web): shop generation pickers use the live model list with a snapshot fallback" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 12: AI Deploy chatbot model card and its proxy route

**Files:**
- Create: `apps/web/app/routes/api.ai.chatbot-model.tsx`
- Create: `apps/web/app/components/dev-shops/ChatbotModelCard.tsx`
- Test: `apps/web/app/components/dev-shops/ChatbotModelCard.test.tsx`
- Modify: `apps/web/app/routes/dev.ai-deploy.tsx:12-36, 42-47, 208-226, 300-312`

**Interfaces:**
- Consumes (Task 6): `GET/POST /api/ai/chatbot-model`; (Task 10) `ModelPicker`, `PickerModel`; (Task 11) `pickerModelsFrom`; `DEFAULT_TEXT_MODEL_ID` from `@repo/utils`; `postJson` inside the route.
- Produces: resource route `/api/ai/chatbot-model` (loader proxies GET, action proxies POST); `ChatbotModelCard` props `{ models: PickerModel[]; savedModelId: string | null; savedAt: string | null; defaultModelId: string; onSave: (modelId: string) => Promise<void> }`.

- [ ] **Step 1: Write the failing card test**

Create `apps/web/app/components/dev-shops/ChatbotModelCard.test.tsx`:

```tsx
/** Server markup of the chatbot model card: current-choice line and picker. */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatbotModelCard } from "./ChatbotModelCard";
import type { PickerModel } from "./modelPicker.helpers";

const MODELS: PickerModel[] = [
  {
    id: "google/gemini-3.1-flash-lite-preview",
    name: "Gemini 3.1 Flash Lite",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    vendor: "google",
    vendorLabel: "Google",
    costPer1MInput: 0.25,
    costPer1MOutput: 1.5,
    supportsEffort: true,
  },
  {
    id: "openai-api/gpt-6-astra",
    name: "GPT-6 Astra",
    provider: "openai",
    providerLabel: "OpenAI API",
    vendor: "openai",
    vendorLabel: "OpenAI",
    costPer1MInput: 10,
    costPer1MOutput: 50,
    supportsEffort: true,
  },
];

const noop = async () => {};

describe("ChatbotModelCard", () => {
  it("explains that the code default applies until a choice is saved", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard models={MODELS} savedModelId={null} savedAt={null} defaultModelId="google/gemini-3.1-flash-lite-preview" onSave={noop} />,
    );
    expect(html).toContain("Shop chatbot model");
    expect(html).toContain("Using the code default until saved: Gemini 3.1 Flash Lite");
    expect(html).toContain('data-testid="picker-provider"');
    expect(html).not.toContain('data-testid="picker-effort"');
  });

  it("shows the saved choice and date", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard
        models={MODELS}
        savedModelId="openai-api/gpt-6-astra"
        savedAt="2026-09-12T10:15:00.000Z"
        defaultModelId="google/gemini-3.1-flash-lite-preview"
        onSave={noop}
      />,
    );
    expect(html).toContain("Current: GPT-6 Astra, saved 2026-09-12");
    expect(html).toContain("Save chatbot model");
  });

  it("names an unknown saved id rather than hiding it", () => {
    const html = renderToStaticMarkup(
      <ChatbotModelCard models={MODELS} savedModelId="x-ai/grok-9" savedAt={null} defaultModelId="google/gemini-3.1-flash-lite-preview" onSave={noop} />,
    );
    expect(html).toContain("Current: x-ai/grok-9");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run from `apps/web`: `npx vitest run app/components/dev-shops/ChatbotModelCard.test.tsx`
Expected: FAIL (module not found).

- [ ] **Step 3: Create the card**

`apps/web/app/components/dev-shops/ChatbotModelCard.tsx`:

```tsx
// Platform-wide chatbot model (one choice for every shop's visitor chatbot).
// Presentational apart from the save state; the route owns the request.
import { useState } from "react";
import { Button } from "~/components/ui/Button";
import { ModelPicker } from "./ModelPicker";
import type { PickerModel } from "./modelPicker.helpers";

export function ChatbotModelCard({
  models,
  savedModelId,
  savedAt,
  defaultModelId,
  onSave,
}: {
  models: PickerModel[];
  /** Value stored by the platform, null until the first save. */
  savedModelId: string | null;
  savedAt: string | null;
  /** The chatbot worker's code default, used until a choice is saved. */
  defaultModelId: string;
  onSave: (modelId: string) => Promise<void>;
}) {
  const effectiveId = savedModelId ?? defaultModelId;
  const [choice, setChoice] = useState(effectiveId);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const nameOf = (id: string) => models.find((m) => m.id === id)?.name ?? id;
  const dirty = choice !== effectiveId;

  async function handleSave() {
    if (!dirty || state === "saving") return;
    setState("saving");
    setError("");
    try {
      await onSave(choice);
      setState("saved");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Could not save the chatbot model.");
      setState("error");
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-white/10 bg-dark-100 p-4" aria-labelledby="chatbot-model-heading">
      <h2 id="chatbot-model-heading" className="font-heading text-lg font-bold text-white">
        Shop chatbot model
      </h2>
      <p className="text-xs text-white/50">
        One choice for every shop&apos;s visitor chatbot. Reasoning effort is never sent to the chatbot.
      </p>
      <p className="text-sm text-white/70" data-testid="chatbot-model-current">
        {savedModelId
          ? `Current: ${nameOf(savedModelId)}${savedAt ? `, saved ${savedAt.slice(0, 10)}` : ""}`
          : `Using the code default until saved: ${nameOf(defaultModelId)}`}
      </p>
      <ModelPicker
        label="Chatbot"
        models={models}
        value={choice}
        onChange={(id) => {
          setChoice(id);
          setState("idle");
        }}
        disabled={state === "saving"}
      />
      <Button onClick={handleSave} disabled={!dirty || state === "saving"} className="w-full">
        {state === "saving" ? "Saving…" : "Save chatbot model"}
      </Button>
      {state === "saved" && (
        <p className="text-xs text-emerald-400">Saved. New conversations use this model from now on.</p>
      )}
      {state === "error" && <p className="text-xs text-red-400">{error}</p>}
    </section>
  );
}
```

Run from `apps/web`: `npx vitest run app/components/dev-shops/ChatbotModelCard.test.tsx`
Expected: PASS.

- [ ] **Step 4: Create the proxy resource route**

`apps/web/app/routes/api.ai.chatbot-model.tsx` (no default export: it is a resource route, see `apiRoutesAreResourceRoutes.test.ts`):

```tsx
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/cloudflare";
import { json } from "@remix-run/cloudflare";
import { getSessionToken } from "~/lib/auth";
import { buildWorkerUpstreamHeaders, workerResponseLooksLikeJson } from "~/lib/worker-upstream-headers";

/** Proxy for the platform chatbot model: GET reads it, POST { model_id } saves it. */
async function proxy(request: Request, context: LoaderFunctionArgs["context"], method: "GET" | "POST") {
  const token = getSessionToken(request);
  if (!token) return json({ success: false, error: "Unauthorized" }, 401);
  const env = context.env as { API_URL: string };

  const res = await fetch(`${env.API_URL}/api/ai/chatbot-model`, {
    method,
    headers: {
      ...buildWorkerUpstreamHeaders(request, token),
      ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: (await request.text()) || "{}" } : {}),
  });
  if (!workerResponseLooksLikeJson(res)) return json({ success: false, error: "Bad gateway" }, { status: 502 });
  return json(await res.json(), { status: res.status });
}

export const loader = ({ request, context }: LoaderFunctionArgs) => proxy(request, context, "GET");
export const action = ({ request, context }: ActionFunctionArgs) => proxy(request, context, "POST");
```

- [ ] **Step 5: Render the card on AI Deploy**

`apps/web/app/routes/dev.ai-deploy.tsx`:

Imports: after line 12 (`import { ModelPicker } ...`) add:

```ts
import { ChatbotModelCard } from "~/components/dev-shops/ChatbotModelCard";
import { pickerModelsFrom } from "~/components/dev-shops/constants";
import { DEFAULT_TEXT_MODEL_ID } from "@repo/utils";
```

Loader: after the `Shop` interface add

```ts
type ChatbotModelRecord = { model_id: string | null; updated_at: string | null };
```

and replace the loader body's tail (after the existing `try { [shops, models] = ... } catch { }` block) so the function reads:

```ts
  let shops: Shop[] = [];
  let models: AIModel[] = [];
  try {
    [shops, models] = await Promise.all([
      api.get<Shop[]>("/api/shops"),
      api.get<AIModel[]>("/api/ai/models"),
    ]);
  } catch {
    // silent
  }
  // Separate try: a failure here must not blank the model list.
  let chatbotModel: ChatbotModelRecord = { model_id: null, updated_at: null };
  try {
    chatbotModel = await api.get<ChatbotModelRecord>("/api/ai/chatbot-model");
  } catch {
    // card shows the code default
  }
  return json({ shops, models, chatbotModel, apiUrl: env.API_URL });
```

Component: change the destructure and the text list:

```ts
  const { shops, models, chatbotModel, apiUrl } = useLoaderData<typeof loader>();
  const [params] = useSearchParams();

  const textModels = pickerModelsFrom(models, "text");
```

(`recommendedId` and everything else that reads `textModels` stays as is; `pickerModelsFrom` returns `AIModel`s when live, snapshot entries otherwise. The `selectedModel = models.find(...)` on line 65 must become `textModels.find(...)` so a snapshot-backed selection still resolves.)

Replace the pricing caption (lines 221 to 225) with:

```tsx
            <p className="mt-1 text-xs text-white/50">
              {textModels.some((m) => m.livePricing)
                ? "Live pricing, refreshed hourly."
                : "Price feed unreachable, showing last-known pricing."}
            </p>
```

After the `{compareMode && (...)}` block (after its closing `)}` around line 312) and before the `{error && (` block insert:

```tsx
          <ChatbotModelCard
            models={textModels}
            savedModelId={chatbotModel.model_id}
            savedAt={chatbotModel.updated_at}
            defaultModelId={DEFAULT_TEXT_MODEL_ID}
            onSave={async (id) => {
              await postJson("/api/ai/chatbot-model", { model_id: id });
            }}
          />
```

- [ ] **Step 6: Type check, lint, tests, build**

Run from `apps/web`: `npx tsc && npm run lint && npx vitest run && npm run build`
Expected: all clean; `apiRoutesAreResourceRoutes.test.ts` passes for the new route; the build emits no `.js` twin under `app/routes/` (check with `git status --short app/routes`).

- [ ] **Step 7: Commit**

```bash
git add apps/web/app/routes/api.ai.chatbot-model.tsx apps/web/app/components/dev-shops/ChatbotModelCard.tsx apps/web/app/components/dev-shops/ChatbotModelCard.test.tsx apps/web/app/routes/dev.ai-deploy.tsx
git commit -m "feat(web): AI Deploy chatbot model card backed by the platform chatbot-model endpoints" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

---

### Task 13: Whole-tree verification, runbook, repo notes

**Files:**
- Create: `docs/runbooks/multi-provider-llm-rollout.md`
- Modify: `CLAUDE.md` (Secrets section and AI / Background Workers section)

**Interfaces:**
- Consumes: everything above.
- Produces: a green tree at the root commands CI runs, and the operator's rollout instructions (spec section 8).

- [ ] **Step 1: Run exactly what CI runs, from the repo root**

```bash
npm ci
npm run check-types
npm run lint
npm test
npm run build
```

Expected: every step exits 0. `npm test` now includes `@repo/llm` (4 files), `pivot-parlor-chatbot` (1 file), the API worker suite and the web suite. If `npm run lint` flags the new worker workspaces, they have no `lint` script and Turbo skips them; a failure is inside `apps/web` or `packages/ui`, fix it there.

Bundle the three background workers once more (proves the final tree deploys):

```bash
for w in research text chatbot; do (cd "apps/workers/$w" && npx wrangler deploy --dry-run --outdir "$(mktemp -d)") || echo "FAILED $w"; done
```

Expected: three "--dry-run: exiting now." lines and no `FAILED`.

- [ ] **Step 2: Write the rollout runbook**

Create `docs/runbooks/multi-provider-llm-rollout.md`:

```markdown
# Multi-provider LLM rollout

Spec: `docs/superpowers/specs/2026-09-12-multi-provider-llm-design.md` (section 8).
Everything below is run by the operator by hand, in this order. The background
workers never deploy from CI.

## 1. Secrets (once per worker and environment)

The direct routes are optional: a worker without a key hides that provider
group (API worker) or falls back to the default model (background workers).

```bash
# API worker: production and staging
cd apps/worker
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY --env staging
npx wrangler secret put ANTHROPIC_API_KEY --env staging

# Background workers (production only; they have no staging deployment)
cd ../workers/research && npx wrangler secret put OPENAI_API_KEY && npx wrangler secret put ANTHROPIC_API_KEY
cd ../text && npx wrangler secret put OPENAI_API_KEY && npx wrangler secret put ANTHROPIC_API_KEY
cd ../chatbot && npx wrangler secret put OPENAI_API_KEY && npx wrangler secret put ANTHROPIC_API_KEY
```

## 2. Deploy the background workers, in order

```bash
cd apps/workers/research && npx wrangler deploy
cd ../text && npx wrangler deploy
cd ../chatbot && npx wrangler deploy
```

They keep working on OpenRouter ids before the API worker ships; direct ids
only arrive once a developer picks one.

## 3. Merge the PR

CI deploys the API worker and the web app. The model cache key changes to
`ai:models:v3`, so the first `/api/ai/models` call after deploy rebuilds the
list (three fetches, up to 10 s each).

## 4. Verify on a test shop

1. AI Deploy: the Theme provider select shows OpenRouter, OpenAI API,
   Anthropic API. Pick Anthropic API, Claude Sonnet 5, Generate. In
   `npx wrangler tail pivot-parlor-api` look for
   `[AI Generator] llm route=anthropic model=claude-sonnet-5 in=<n> out=<n>`.
2. Shop page: pick OpenAI API, GPT-5.6 Luna for Text & research, Regenerate.
   `npx wrangler tail pivot-parlor-research` shows `llm route=openai model=gpt-5.6-luna`,
   and `npx wrangler tail pivot-parlor-text` shows the same route.
3. Chatbot card: save a model, send a message on a shop site,
   `npx wrangler tail pivot-parlor-chatbot` shows `[chatbot] llm route=<route> model=<model>`,
   and the newest `ai_usage_log` row's `model` column holds the saved id.
4. Registry contents:
   `npx wrangler kv key get --namespace-id 12eca802e7ff47c2a5358da0f985eecd ai:models:v3 | head -c 600`
   shows entries with `"provider":"openai"` and `"provider":"anthropic"`.

## 5. Watch billing

OpenRouter, OpenAI and Anthropic dashboards for the first week.

## Rollback

- Chatbot: save `google/gemini-3.1-flash-lite-preview` on the card, or delete
  the KV key `platform:chatbot:model`; the worker falls back to the code default.
- Site generation and themes: pick OpenRouter models again. A shop whose
  stored id is on a hidden group (key removed) degrades to the default text
  model with a `[generate-site]` warning; nothing fails.
- Workers: redeploy the previous commit of each worker by hand.
```

- [ ] **Step 3: Update the repo notes**

`CLAUDE.md`, in "### Secrets", add after the Worker secrets bullet:

```markdown
- **LLM vendor keys**: `OPENROUTER_API_KEY` (required), `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` (optional, direct routes) on the API worker (production and staging) and on the research, text and chatbot workers. Rollout steps: `docs/runbooks/multi-provider-llm-rollout.md`.
```

In "### AI / Background Workers", append after the list:

```markdown
`research`, `text`, `chatbot` and `booking` are npm workspaces (root `workspaces`). Every LLM call goes through `@repo/llm` (`packages/llm`, `chatComplete`) with route-qualified model ids: `openai-api/<model>` and `anthropic-api/<model>` call the vendors directly, anything else is an OpenRouter slug. `/api/ai/models` is ranked live by `apps/worker/src/services/model-registry.ts` and cached in KV (`ai:models:v3`); `packages/utils/src/modelCatalog.ts` is the snapshot fallback and fallback price table (refresh it together with `apps/worker/test/fixtures/model-feeds.ts`). The chatbot's model is platform-wide (`platform:chatbot:model`, set on AI Deploy).
```

- [ ] **Step 4: Commit**

```bash
git add docs/runbooks/multi-provider-llm-rollout.md CLAUDE.md
git commit -m "docs: multi-provider LLM rollout runbook and repo notes" -m "Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LMfRpnPeH7bdF1jwW7xinB"
```

- [ ] **Step 5: Hand over**

Push `feat/multi-provider-llm`, open the PR to `main` with the `e2e` label, and end the PR body with the attribution lines from the Global Constraints. Do not merge; the user merges after the runbook's step 1 and 2 are done.
