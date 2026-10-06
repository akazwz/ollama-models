# Ollama Models API

[![Check](https://github.com/akazwz/ollama-models/actions/workflows/check.yml/badge.svg)](https://github.com/akazwz/ollama-models/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A free JSON API listing every model in the [Ollama library](https://ollama.com/library) with its description and all of its tags, refreshed daily.

Ollama has no public endpoint for browsing the library, so tools that want a model picker or tag autocomplete have to scrape the website themselves. This project does that once a day and serves the result from Cloudflare's edge.

```sh
curl https://ollama-models.zwz.workers.dev
```

```json
[
  {
    "name": "gpt-oss",
    "description": "OpenAI’s open-weight models designed for powerful reasoning, agentic tasks, and versatile developer use cases.",
    "tags": ["latest", "20b", "120b", "20b-cloud", "120b-cloud"]
  }
]
```

As of October 2026 the catalog holds 240+ models and 7,400+ tags. If it saves you a scraper, a star helps other people find it.

## Usage

No key, no sign-up, one endpoint: `GET https://ollama-models.zwz.workers.dev/` returns the whole catalog as a JSON array. CORS is open, so it also works straight from a browser.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Model name as used in `ollama pull <name>` |
| `description` | `string` | Short description from the library page |
| `tags` | `string[]` | Every tag of the model: `latest`, sizes, quantizations, instruct/thinking variants and cloud aliases |

Join `name` and a tag with a colon to get something you can pull, for example `gpt-oss:20b`.

```js
const models = await (await fetch("https://ollama-models.zwz.workers.dev")).json();
const qwen3 = models.find((model) => model.name === "qwen3");
```

```python
import requests

models = requests.get("https://ollama-models.zwz.workers.dev").json()
names = [model["name"] for model in models]
```

```sh
# Every pullable name:tag, one per line
curl -s https://ollama-models.zwz.workers.dev | jq -r '.[] | .name as $n | .tags[] | "\($n):\(.)"'
```

### Freshness

The catalog is rebuilt every day at 00:00 UTC. Two response headers tell you how old it is:

| Header | Value |
| --- | --- |
| `X-Catalog-Updated-At` | Time of the last successful update, in ISO 8601 |
| `X-Catalog-Stale` | `false`, or `true` when the last successful update is more than 26 hours old |

A failed update never replaces good data: the API keeps serving the last good catalog and reports it as stale. Responses are cacheable for 60 seconds.

This is a best-effort public instance with no uptime guarantee. If your product depends on it, cache the response or [run your own](#run-your-own).

### Something missing?

If a model or tag exists on ollama.com but not here a day later, please [open an issue](https://github.com/akazwz/ollama-models/issues) with an example.

## How it works

A Cloudflare Worker runs on a daily Cron Trigger. It fetches the library page and each model's tags page, extracts models and tags from their canonical `/library/<name>` and `/library/<name>:<tag>` links, and writes the result to Workers KV. `GET /` only reads KV and streams the stored JSON, so visitors never trigger a scrape.

Each request has a 15-second timeout and is retried twice; at most four tag pages are fetched at once. A model's tags page is rejected if it still fails, lists no tags, or lists fewer tags than the library page advertises.

One bad page does not hold back the rest: that model keeps the tags from the previous catalog (a model seen for the first time is left out until its page works) and every other model is updated. If the library page itself fails, more than five models fail, or no model succeeds, something larger is wrong, so the update is abandoned and the previous catalog stays in place.

Workers Logs record `catalog_sync_succeeded` (model and tag counts, duration), `catalog_sync_failed` (the reason), `catalog_model_failed` (the model, the reason and whether its previous tags were kept) and `catalog_fetch_retried`. A failed Cron run is also reported as a failed invocation in Cloudflare's metrics.

## Run your own

You need a Cloudflare account on the **Workers Paid** plan: one update makes a request per model, well over the Free plan's limit of 50 subrequests per invocation ([limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests)).

Requires **Node.js 22.18+** and **pnpm 12.8.1**.

```sh
pnpm install --frozen-lockfile
pnpm exec cf auth login
pnpm run deploy
```

The Worker is described in [`cloudflare.config.ts`](cloudflare.config.ts) and deployed with the [Cloudflare CLI](https://developers.cloudflare.com/cf/) (`cf`, currently in beta), which bundles through Wrangler. The KV binding has no namespace id: the first deploy offers to create a namespace, and later deploys keep the one already bound to the Worker.

A new deployment answers **503** until its first update. Wait for the next Cron run, or trigger one by hand: store a random `SYNC_TOKEN` in `.env.production`, upload it with the deploy, and call `/sync`.

```sh
pnpm exec cf deploy --secrets-file .env.production
curl -X POST https://<your-worker>.workers.dev/sync \
  -H 'Authorization: Bearer <your SYNC_TOKEN>'
```

`/sync` only accepts an authenticated `POST` and is disabled while `SYNC_TOKEN` is not set. The Cron Trigger does not need the token.

`cf` cannot yet set a single secret or stream logs, so use Wrangler for those:

```sh
pnpm exec wrangler secret put SYNC_TOKEN --name ollama-models
pnpm exec wrangler tail ollama-models
```

## Development

```sh
pnpm install --frozen-lockfile
cp .env.example .env   # set a random SYNC_TOKEN
pnpm dev
```

Local development uses a simulated KV namespace, so it needs no Cloudflare resources. Fill it with a manual update:

```sh
curl -X POST http://localhost:8787/sync \
  -H 'Authorization: Bearer <your SYNC_TOKEN>'
curl -i http://localhost:8787/
```

```sh
pnpm check        # lint, types and offline tests
pnpm build        # bundle and dry-run a deploy; never publishes
pnpm check:source # full scrape of the live Ollama website
```

The tests have no network dependency. `pnpm check:source` scrapes ollama.com for real, and with `--api=<url>` also verifies that a running API contains every model and tag found at the source:

```sh
pnpm check:source --api=https://ollama-models.zwz.workers.dev/
```

Binding and runtime types are inferred from `cloudflare.config.ts` and written to `.cloudflare/types` by `pnpm typecheck`, `pnpm dev` and `pnpm build`. CI runs `pnpm check` and `pnpm build` on every push and pull request.

Issues and pull requests are welcome.

## License

[MIT](LICENSE). Not affiliated with Ollama.
