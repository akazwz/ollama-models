# Ollama Models API

A Cloudflare Worker serving a daily snapshot of the public [Ollama model library](https://ollama.com/library), including descriptions and all linked tags.

**API:** [ollama-models.zwz.workers.dev](https://ollama-models.zwz.workers.dev)

```json
[
  { "name": "qwen3", "description": "...", "tags": ["latest", "4b", "4b-thinking-2507-q8_0"] }
]
```

The API continues to return a JSON array. Tags include `latest`, quantizations, instruct/thinking variants and cloud aliases exposed by Ollama. Duplicate links are removed.

## Synchronization

Cron runs daily at **00:00 UTC** (`0 0 * * *`). Model names and tags are extracted from canonical Ollama links, rather than layout-specific list elements. Tag counts advertised in the library are checked when present.

Requests have a 15-second timeout, and at most four tag pages are fetched simultaneously. A failed request is retried twice, after 1 and 2 seconds, and each retry is logged as `catalog_fetch_retried`. Persistent HTTP errors, missing models, empty tags and incomplete tag pages fail the entire sync. Only a complete, validated catalog is written to KV, in a single write that also records its update time as KV metadata; failures keep the previous catalog.

`GET /` only reads KV: the stored value is the response body and is streamed as-is. A new installation returns **503** until the first successful sync. This keeps visitor requests from launching expensive full scrapes. Arrays stored by earlier versions remain readable.

Response headers expose freshness:

- `X-Catalog-Updated-At`: last successful update, in ISO format.
- `X-Catalog-Stale`: `false`, `true` after 26 hours, or `unknown` for legacy data without a timestamp.

Workers Logs record `catalog_sync_succeeded` (model/tag counts and duration) or `catalog_sync_failed` (the failing URL/model and reason). Cron failures propagate to Cloudflare's invocation metrics. No external notification service is required.

## Local development

Requires **Node.js 22.18+** and **pnpm 12.8.1**.

The Worker is configured in [`cloudflare.config.ts`](cloudflare.config.ts) and run with the [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`cf`, currently in beta), which bundles through Wrangler.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Set a random `SYNC_TOKEN` in `.env`. It is loaded automatically during local development and is excluded from Git. Local development uses a simulated KV namespace, so no Cloudflare resources are needed:

```sh
pnpm dev
```

Bootstrap the local snapshot with an authenticated manual sync:

```sh
curl -X POST http://localhost:8787/sync \
  -H 'Authorization: Bearer <your SYNC_TOKEN>'
curl -i http://localhost:8787/
```

Manual sync requires **POST** and a bearer token. It is disabled when `SYNC_TOKEN` is absent. Cron does not require this token.

The full catalog takes one library request plus one request per model. It currently exceeds the Workers Free limit of 50 external subrequests per invocation: this synchronization design requires **Workers Paid**. See [Cloudflare's limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests).

## Checks

```sh
pnpm check        # formatting/lint, types, offline regression tests
pnpm build        # bundle and dry-run a deploy; does not publish
pnpm audit        # dependency advisories
pnpm check:source # explicit full scrape against the current Ollama website
```

Regular tests have no network dependency. The live check also verifies the instruct/thinking tags reported in issue #4. To compare a running API against the source:

```sh
pnpm check:source --api=http://localhost:8787/
```

CI runs offline checks and bundle validation on pushes and pull requests. Binding and runtime types are inferred from `cloudflare.config.ts` and regenerated into `.cloudflare/types` by `pnpm typecheck`, `pnpm dev` and `pnpm build`. Optional manual-sync secret typing is defined in `WorkerEnv`.

## Publishing

```sh
pnpm exec cf auth login
pnpm run deploy
```

The KV binding has no namespace id: a deploy keeps the namespace already bound to the Worker, and a first deploy offers to create one.

Provide `SYNC_TOKEN` as a Worker secret if manual sync is needed, either from a dotenv file while deploying or on its own through Wrangler:

```sh
pnpm exec cf deploy --secrets-file .env.production
pnpm exec wrangler secret put SYNC_TOKEN --name ollama-models
```

`cf` cannot stream logs yet; use `pnpm exec wrangler tail ollama-models`.

Publishing is a separate manual operation. The validation commands above never publish the Worker. See [Cloudflare's secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/).

## License

MIT.
