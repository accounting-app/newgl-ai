# newgl-ai

Internal AI service for New GL. Handles everything that talks to Anthropic on
behalf of a tenant: BYOK (bring-your-own-key) credential storage, usage
metering and quota enforcement, and the AI features themselves (CSV column
mapping, payee normalization, transaction categorization).

It has no public IP and no user-facing routes. The only caller is
[`newgl-api`](../newgl-api), which reaches it over a private network in
production (Fly.io) or `localhost` in development, authenticated with a
shared secret. `newgl-ai` never sees a Supabase session, a user, or a
plaintext BYOK key outside the request that just set it.

## Architecture

- **Runtime**: [Bun](https://bun.sh) + TypeScript, run directly with no build
  step.
- **HTTP**: [Hono](https://hono.dev), plain routes (no OpenAPI layer) under
  `/internal/*`.
- **Database**: the same Postgres instance as `newgl-api`, via Bun's built-in
  SQL client. `newgl-api`'s migrations own the schema; `newgl-ai` only reads
  and writes the `ai_credentials`, `ai_usage`, and `payee_rules` tables.
- **AI provider**: Anthropic's Messages API, via the official pattern (no
  SDK dependency) in `src/infra/anthropic/`.
- **Auth**: every route except `/internal/health` requires an
  `X-Internal-Token` header matching `INTERNAL_SERVICE_TOKEN`. There is no
  other authentication layer — this service is not meant to be reachable
  from anywhere a browser or end user could hit it directly.

```
src/
  domain/            Types and Zod schemas shared across the service
  application/        Service interfaces (contracts.ts) + implementations,
                       wired together in create-service-container.ts
  infra/
    postgres/          Repositories (ai_credentials, ai_usage, payee_rules)
    anthropic/         Real Anthropic client + API-key validator
  http/
    routes/            One file per route group, thin HTTP -> service calls
    middleware/         Shared-secret auth
  testing/             Fake Anthropic client + key validator (AI_TEST_MODE)
  shared/              Crypto (AES-256-GCM), payee normalization, errors
```

### Key resolution and quota

Every AI-calling route resolves, per tenant, whether to use that tenant's own
Anthropic key (BYOK) or the platform's key:

- **BYOK**: the tenant's key is decrypted, used directly, and never counted
  against any quota — they're paying Anthropic themselves.
- **Platform key**: usage (actions and tokens) is metered in `ai_usage` and
  checked against the monthly limits `newgl-api` passes in on each request
  (it owns the concept of a "plan"; this service just enforces whatever
  numbers it's given). Exceeding the limit returns `402 Payment Required`.

### The learned-rules cascade

Payee normalization and transaction categorization both check `payee_rules`
for an existing match before calling Anthropic at all. Only genuinely new
payees are batched into a single model call; everything already seen once
resolves for free. This is what keeps repeat imports cheap.

## Endpoints

All under the shared-secret middleware except health:

| Method & path | Purpose |
| --- | --- |
| `GET /internal/health` | Liveness check, no auth required |
| `PUT /internal/ai/credentials` | Set (and validate-on-save) a tenant's BYOK Anthropic key |
| `DELETE /internal/ai/credentials` | Remove a tenant's BYOK key, fall back to the platform key |
| `GET /internal/ai/status` | Key source (platform/byok), masked key, model, validation date |
| `GET /internal/ai/usage` | Usage summary for the current period, checked against limits passed in |
| `POST /internal/ai/column-mapping` | Suggest a CSV column -> transaction field mapping |
| `POST /internal/ai/payees/normalize` | Suggest clean merchant names for a batch of raw payee strings |
| `POST /internal/ai/rules/learn` | Record user-confirmed payee -> account mappings |
| `POST /internal/ai/categorize` | Suggest a counterparty account for a batch of transactions |

None of these are meant to be called directly — see `newgl-api`'s
`src/http/routes/ai.ts` for the public-facing proxy routes that a real
client (the `quickslike` frontend) actually talks to.

## Prerequisites

- [Bun](https://bun.sh) `>= 1.3.13` (`curl -fsSL https://bun.sh/install | bash`)
- A running Postgres instance with `newgl-api`'s migrations applied — the
  easiest way is `newgl-api`'s local Supabase stack:
  ```bash
  cd ../newgl-api
  bunx supabase start   # first time: bunx supabase init has already been run
  bunx supabase db reset # applies every migration, including the ai_* tables
  ```
- An Anthropic API key for local testing (or set `AI_TEST_MODE=true`, see
  below, to skip needing one entirely).

## Install

```bash
bun install
```

## Configure

Copy the example env file and fill it in:

```bash
cp .env.example .env
```

| Variable | Required | Notes |
| --- | --- | --- |
| `APP_ENV` | no | `local` \| `development` \| `staging` \| `production` (default `local`) |
| `PORT` | no | Default `3002` |
| `DATABASE_URL` | yes | Same Postgres as `newgl-api`. Local Supabase default: `postgresql://postgres:postgres@127.0.0.1:54322/postgres` |
| `INTERNAL_SERVICE_TOKEN` | yes | Shared secret with `newgl-api`. **Must match `newgl-api/.env`'s `INTERNAL_SERVICE_TOKEN` exactly.** Generate with `openssl rand -hex 32` |
| `AI_KEY_ENCRYPTION_KEY` | yes | Master key for encrypting BYOK Anthropic keys at rest (AES-256-GCM). Must be base64 for exactly 32 bytes. Generate with `openssl rand -base64 32` |
| `ANTHROPIC_API_KEY` | yes* | Platform key, used for any tenant with no BYOK key set. Not required if `AI_TEST_MODE=true` |
| `ANTHROPIC_MODEL` | no | Default `claude-opus-4-8` |
| `AI_TEST_MODE` | no | Set to `true` to use fake key validation and fake Anthropic responses instead of calling the real API — no `ANTHROPIC_API_KEY` needed. Test/dev only, never set in production |

`INTERNAL_SERVICE_TOKEN` is the one value that has to be coordinated with
`newgl-api`: generate it once, put the same value in both `.env` files.

## Run

```bash
bun run dev     # bun --watch src/index.ts -- restarts on file changes
# or
bun run start   # bun src/index.ts -- no watcher, for production-like runs
```

On startup you should see:

```
[newgl-ai] env=local model=claude-opus-4-8
[newgl-ai] listening on http://localhost:3002 (internal only)
```

Verify it's up:

```bash
curl http://localhost:3002/internal/health
# {"status":"ok","timestamp":"..."}
```

Every other endpoint needs the shared secret:

```bash
curl http://localhost:3002/internal/ai/status?tenantId=<uuid> \
  -H "X-Internal-Token: <your INTERNAL_SERVICE_TOKEN>"
```

In normal development you won't call this service directly at all — start
`newgl-api` too (it proxies everything under `/api/ai/*`) and drive it
through that, or through the `quickslike` frontend.

## Testing

```bash
bun test
```

Tests use `AI_TEST_MODE`'s fake Anthropic client/key validator and a local
Postgres, so they run without a real Anthropic account. They do require a
reachable Postgres with the schema applied (same local Supabase stack as
above) — tests skip with a warning instead of failing if it isn't reachable.
