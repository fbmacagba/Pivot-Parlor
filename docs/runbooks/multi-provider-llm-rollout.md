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
