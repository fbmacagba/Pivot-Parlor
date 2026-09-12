# Multi-provider LLM routing: OpenRouter, OpenAI API, Anthropic API

**Status:** approved in brainstorming on 2026-09-12; implementation plan to follow.
**Owner:** developer dashboard (platform operator). Shop owners never see a model picker.

## 1. Goal

Let the developer choose, for every AI feature that has a model picker, between three
providers: **OpenRouter** (today's gateway), the **OpenAI API** called directly, and the
**Anthropic API** called directly. The direct providers list the top four tiers of each
vendor, discovered live rather than hard-coded, with timely and accurate prices. OpenRouter
keeps its own entry, and its list also reflects the current top tier per vendor.

Decisions taken during brainstorming (do not re-ask):

- **Keys are platform keys.** One `OPENAI_API_KEY` and one `ANTHROPIC_API_KEY`, stored as
  worker secrets exactly like `OPENROUTER_API_KEY`. Pivot Parlor pays; every shop shares them.
  No per-developer or per-shop keys.
- **Lists are live and ranked by rule** (section 3). New releases appear without a code change.
- **Scope is everything with a picker, plus the chatbot:** site generation (research and text
  workers), AI Deploy theme generation, and the customer-facing shop chatbot. Image generation
  stays on OpenRouter.
- **The chatbot model is one platform-wide choice**, set once in the developer dashboard.
- **Approach:** route-qualified model ids plus one shared LLM client used by every caller
  (section 4), not per-caller patches and not an OpenRouter-only shortcut for site generation.

## 2. Facts the design rests on (verified 2026-09-12)

- Neither vendor publishes prices through its API. Anthropic `GET /v1/models` returns `id`,
  `display_name`, `created_at`, `max_input_tokens`, `max_tokens` and a `capabilities` block
  that includes the supported `effort` levels. OpenAI `GET /v1/models` returns `id`, `created`,
  `owned_by`, `shutdown_date`.
- OpenRouter's public `GET https://openrouter.ai/api/v1/models` (no key needed) carries
  per-token prices at the vendors' list prices for every OpenAI and Anthropic model, plus
  `supported_parameters` (`reasoning`) and `architecture.output_modalities`.
- Live ids today: `openai/gpt-6-astra`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`,
  `openai/gpt-5.6-luna` (each also has `-pro` and `:batch` variants);
  `anthropic/claude-fable-5.1`, `anthropic/claude-opus-5`, `anthropic/claude-sonnet-5`,
  `anthropic/claude-haiku-4.5`. OpenAI's tier is spelled **Terra**.
- All four workers that call an LLM (`apps/worker`, `apps/workers/research`,
  `apps/workers/text`, `apps/workers/chatbot`) share the same production KV namespace and
  each holds its own `OPENROUTER_API_KEY` secret. Each has its own copy of the OpenRouter HTTP
  call; there is no shared helper today.
- Per-shop generation settings live in KV under `gen:settings:<shopId>` with fields
  `text_model`, `text_effort`, `image_model`, `composer`. The theme pipeline records the last
  model used in the D1 column `shops.ai_model`. Model ids are validated in
  `apps/worker/src/routes/shops.ts` (settings-save, generate-site, generate-image) with the
  error text `Unknown text model: <id>` / `Unknown image model: <id>`.

## 3. Model ids and the live registry

### 3.1 Ids

A model choice is one opaque string everywhere it is stored or forwarded.

| Route | Id form | Example |
|---|---|---|
| OpenRouter | OpenRouter's own slug, unchanged | `anthropic/claude-sonnet-5` |
| OpenAI API | `openai-api/<vendor model id>` | `openai-api/gpt-6-astra` |
| Anthropic API | `anthropic-api/<vendor model id>` | `anthropic-api/claude-fable-5.1` |

`parseModelId(id)` returns `{ route: "openrouter" | "openai" | "anthropic", model: string }`.
Anything with the `openai-api/` prefix is OpenAI, `anthropic-api/` is Anthropic, everything
else is OpenRouter with the whole id as the model. Malformed ids (empty model part) are
rejected by validation. `priceTwin(id)` maps a direct id to its OpenRouter slug for the price
lookup: `openai-api/X` to `openai/X`, `anthropic-api/X` to `anthropic/X`.

### 3.2 Groups

The registry (`apps/worker/src/services/model-registry.ts`, rewritten) produces three text
groups and one image group, cached in KV for one hour under a new key `ai:models:v3`.

**OpenAI API group.** Source: `GET https://api.openai.com/v1/models` with the platform key.
Keep ids matching `^gpt-(\d+(?:\.\d+)?)-(astra|sol|terra|luna)$` (this excludes `-pro`,
`:batch`, `gpt-chat-latest`, `-nano`, image models). For each tier take the newest generation
number that has it; order Astra, Sol, Terra, Luna. Today: `gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`.

**Anthropic API group.** Source: `GET https://api.anthropic.com/v1/models` with the platform
key and `anthropic-version: 2023-06-01`, paginated with `limit=1000`. Keep ids matching
`^claude-(fable|opus|sonnet|haiku)-(\d+(?:\.\d+)?)$`. For each family take the highest
version; order Fable, Opus, Sonnet, Haiku. Today: `claude-fable-5.1`, `claude-opus-5`,
`claude-sonnet-5`, `claude-haiku-4.5`. Supported effort levels come from
`capabilities.effort` (`low`, `medium`, `high`; `max` and `xhigh` are ignored because the
product exposes three levels).

**OpenRouter group.** Source: OpenRouter's public list. Text models only
(`output_modalities` equals `["text"]`), ids without `:` variants, and not matching
`-(exp|preview)$` or a trailing date `-\d{4}$`, except that the configured defaults (section
6) are always kept. Per vendor, a family table gives the ranking; take the highest version
per family, at most four families, in table order:

| Vendor | Family pattern | Order |
|---|---|---|
| `anthropic` | `claude-<family>-<ver>` | fable, opus, sonnet, haiku |
| `openai` | `gpt-<ver>-<tier>` | astra, sol, terra, luna |
| `google` | `gemini-<ver>-<family>` | pro, flash, flash-lite |
| `x-ai` | `grok-<ver>` and `grok-<ver>-multi-agent` | plain, multi-agent |
| `deepseek` | `deepseek-v<ver>-pro`, `deepseek-v<ver>-flash` | pro, flash |

Vendors stay in today's order: google, anthropic, openai, x-ai, deepseek. Today this yields,
for example, `google/gemini-3.8-flash` and `google/gemini-3.5-flash-lite` for Google, and
drops `anthropic/claude-opus-4.8` because Opus 5 exists.

**Image group.** Unchanged: OpenRouter only, the existing curated image entries, live-priced.

### 3.3 Prices, capabilities, fallbacks

- Prices for all groups come from OpenRouter's public feed, converted to USD per million
  tokens as today; direct ids look up their `priceTwin`. Each entry records `livePricing`.
- A fallback price table in `packages/utils/src/modelCatalog.ts` covers the eight direct ids
  and the pinned defaults; it is used when the feed lacks an entry and is checked against the
  feed by a test.
- `supportsEffort`: Anthropic from `capabilities.effort.supported`; OpenAI true for the four
  tiers (all four report `reasoning` on OpenRouter today, and the OpenAI adapter drops the
  parameter on a 400 anyway); OpenRouter from `supported_parameters`.
- Failure handling per group: a failed or non-200 vendor fetch keeps the group from the last
  KV cache; with no cache, the group comes from a static snapshot in the catalogue file. A
  missing platform key hides that direct group entirely and logs one warning per cache
  refresh. The fetches run in parallel with a 10 s timeout each.
- The `/api/ai/models` endpoint returns the groups with a `provider` field on each model:
  `openrouter`, `openai`, `anthropic`; OpenRouter models also carry `vendor` and `vendorLabel`.

## 4. Shared LLM client

New workspace package `packages/llm` (`@repo/llm`), dependency-free, exporting:

```ts
type Route = "openrouter" | "openai" | "anthropic";
type Effort = "low" | "medium" | "high";
interface ProviderKeys { openrouter?: string; openai?: string; anthropic?: string }
interface ChatRequest {
  modelId: string;                 // route-qualified id (section 3.1)
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  effort?: Effort;
  maxTokens: number;
  jsonOnly?: boolean;              // ask for a JSON object and extract it
  signal?: AbortSignal;
}
interface ChatResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  route: Route; model: string;     // what was actually called
}
function chatComplete(req: ChatRequest, keys: ProviderKeys): Promise<ChatResult>;
function parseModelId(id: string): { route: Route; model: string };
function priceTwin(id: string): string;
function maxOutputTokensFor(id: string, requested: number): number;
class LlmError extends Error { route: Route; model: string; status?: number; retryable: boolean }
```

Adapters, one file each:

- **OpenRouter:** `POST https://openrouter.ai/api/v1/chat/completions`, today's headers
  (`Authorization`, `HTTP-Referer`, `X-Title`), body `{ model, max_tokens, messages,
  reasoning: { effort } }` when effort is given. The system prompt is the first message with
  role `system`.
- **OpenAI:** `POST https://api.openai.com/v1/chat/completions`, `Authorization: Bearer`,
  body `{ model, max_completion_tokens, messages, reasoning_effort }` when effort is given;
  system prompt as a `system` message.
- **Anthropic:** `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`,
  `anthropic-version: 2023-06-01`, body `{ model, max_tokens, system, messages,
  output_config: { effort } }` when effort is given; text concatenated from `content` blocks
  of type `text`.

Shared behaviour, implemented once:

- **Effort retry:** a 400 whose body mentions the effort parameter is retried once without
  effort (today's rule in the research and text workers).
- **Rate limits:** a 429 or 5xx is retried up to three times with 3 s, 6 s, 9 s back-off
  (today's research-worker rule), unless the request's `signal` aborts.
- **JSON extraction:** with `jsonOnly`, the first balanced `{...}` in the reply is returned;
  the existing fenced-code stripping moves here.
- **Errors:** `LlmError` messages read `<route>/<model>: HTTP <status> <short body>` or
  `<route>: <network error>`; `retryable` is true for 429, 5xx and network errors.
- **Token caps:** `maxOutputTokensFor` holds the per-id caps that the research and text
  workers currently compute by prefix (`meta-llama/` 4096, `google/gemini-3.1-flash-lite`
  8000), extended with per-route defaults.
- **Missing key:** calling a route whose key is absent throws `LlmError` with status
  `undefined` and message `<route>: API key not configured`; callers apply their default-model
  rescue.

Callers that switch to `chatComplete` and delete their private copies: `apps/worker/src/
services/ai-generator.ts` (`callOpenRouter`), `apps/workers/research/src/index.ts`
(`openRouterJson`), `apps/workers/text/src/index.ts` (`openRouterJson`),
`apps/workers/chatbot/src/openrouter.ts` (`callOpenRouter`). Image generation
(`openrouter-image-generation.ts` and the images worker) is untouched. The research worker's
final-attempt rescue to the default text model stays and now spans routes.

Secrets: `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` added to the `Bindings`/`Env` types of the
four workers, documented in each `wrangler.toml` secrets comment, and set with
`wrangler secret put` (per environment for the API worker: production and staging).

## 5. Developer dashboard

### 5.1 Picker

`ModelPicker` gains a top-level **Provider** select: OpenRouter, OpenAI API, Anthropic API.
OpenRouter keeps the vendor select then the model select; a direct provider shows its model
select directly. Price labels stay as today (`$in / $out per 1M`, fallback marked). The
effort select appears only when the selected model `supportsEffort`, offering the levels the
registry reports (`effortLevels: Effort[]`; three for OpenRouter and OpenAI, Anthropic's
reported subset). `groupByProvider` becomes `groupByRoute` with vendor sub-groups for
OpenRouter. `defaultModelForProvider` keeps picking the `recommended` model, else the first.

### 5.2 Pages

- **AI Deploy** already loads `/api/ai/models`; it keeps that and renders the new picker.
  Compare mode accepts any two ids, across routes.
- **Shop detail (site generation)** switches from `staticPickerModels()` to the live endpoint
  (loader fetch, falling back to the static snapshot when the API is unreachable) so prices
  there are current. Field names and endpoints are unchanged: `text_model`, `text_effort`,
  `image_model`, `composer` to `POST /api/shops/:id/settings`, then `generate-site`.
- **Chatbot model card** on AI Deploy: the same picker (text kind, no effort) and a Save
  button posting `{ model_id }` to `POST /api/ai/chatbot-model` (developer role). The API
  validates the id as a text model and writes KV `platform:chatbot:model` with
  `{ model_id, updated_at }`. `GET /api/ai/chatbot-model` returns the current value for the
  card.

### 5.3 Chatbot worker

On each conversation the chatbot reads `platform:chatbot:model` from the shared KV and calls
`chatComplete` with it; if the key is absent, the id fails `parseModelId`, or the call throws a
non-retryable `LlmError`, it falls back to the code default (today's Gemini Flash Lite id on
OpenRouter) and logs once per request. The effort level is never sent for the chatbot.

## 6. Validation, storage, defaults, existing choices

- Validation keeps its rule and changes source: an explicit id in settings-save, generate-site
  or generate-image must exist in the live registry for that kind, else the same 400 text.
  Stored ids that are no longer listed degrade to the pipeline default with a logged warning,
  as today. Kind checks stay.
- Storage shape is unchanged: `gen:settings:<shopId>` fields, `shops.ai_model`, job payload
  fields `text_model`/`text_effort`/`image_model`. The only new record is
  `platform:chatbot:model`.
- Defaults are unchanged and always listed in their group even when not top-tier:
  `google/gemini-3.1-flash-lite-preview` (text), `google/gemini-3.1-flash-image` (image),
  `anthropic/claude-sonnet-5` (theme). `recommended` stays on Claude Sonnet 5 via OpenRouter.
- No migration: every stored id today is an OpenRouter id and still resolves to the OpenRouter
  route.

## 7. Testing

- **`packages/llm` unit tests** (vitest, stubbed `fetch`): request shape per adapter incl.
  headers and effort field; system prompt placement; JSON extraction; effort retry on a 400;
  429 back-off with fake timers; abort; `LlmError` text; `parseModelId` on all prefixes and
  malformed ids; `priceTwin`; `maxOutputTokensFor`.
- **Registry unit tests** (worker vitest): ranking rules against recorded copies of today's
  three lists produce exactly the eight direct ids in order and the expected OpenRouter top
  tiers; a fabricated `gpt-7-astra` displaces `gpt-6-astra`; a fabricated `claude-opus-6`
  displaces Opus 5; `-pro`, `:batch`, `-exp`, dated ids are excluded; pinned defaults survive;
  a missing key hides the group; a failed fetch keeps the cached group; a missing cache uses the
  snapshot; the fallback price table matches the feed for every id it lists.
- **API tests:** validation accepts direct ids, rejects unknown and wrong-kind ids; chatbot
  model endpoints require the developer role and validate the id.
- **Web tests:** picker provider level, direct path without a vendor step, effort options
  limited to reported levels, shop-detail loader fallback to the snapshot.
- **Chatbot worker test:** reads the platform choice; falls back when absent or invalid.
- The existing `model-catalog.test.ts` and `model-validation.test.ts` are updated for the new
  shapes. The staging E2E gate is unaffected (no spec touches a picker).

## 8. Rollout

1. Set `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` on the API worker (production and staging)
   and on the research, text and chatbot workers.
2. Deploy the background workers by hand in the order research, text, chatbot (they deploy
   manually, never via CI).
3. Merge; CI deploys the API worker and the web app.
4. On a test shop, pick a direct model, run one theme generation and one site generation, and
   confirm from each worker's log line (`route/model` and usage) that the call went to the
   vendor, not to OpenRouter.
5. Watch three billing dashboards for the first week.

Delivery can be one PR or two. If two, the shared package, registry, secrets and worker
changes go first: they are inert until an id with a new prefix is chosen, and the existing
picker keeps working against the new `/api/ai/models` shape because OpenRouter ids are
unchanged. The dashboard changes (picker provider level, live prices on the shop page, chatbot
card) follow.

## 9. Non-goals

- Per-developer or per-shop API keys; shop-owner model pickers.
- Image generation through the direct APIs.
- Batch, fine-tuning, realtime or any vendor-specific API beyond chat completions / messages.
- Changing today's default models.

## 10. Risks

- Vendor naming drift: a tier renamed (for example a future non-numeric generation) would
  fall out of the ranking regex; the registry logs when a group has fewer than two entries so
  the drift is visible, and the snapshot keeps the picker usable.
- Price feed mismatch: OpenRouter lists vendor prices, but a vendor price change can lag by
  hours; the picker labels prices as live or fallback, never as authoritative.
- Parameter names: OpenAI's `reasoning_effort` and Anthropic's `output_config.effort` are the
  2026 names; the adapters' effort retry protects generation if either changes.
