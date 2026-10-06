import { fetchCatalog, type ModelDetail } from "./catalog";

// Bindings come from cloudflare.config.ts; the manual-sync secret is optional.
export interface WorkerEnv extends Env {
	SYNC_TOKEN?: string;
}

interface CatalogMetadata {
	updatedAt: string;
}

const STALE_AFTER_MS = 26 * 60 * 60 * 1000;
const CORS = { "Access-Control-Allow-Origin": "*" };

export async function syncCatalog(env: WorkerEnv) {
	const startedAt = Date.now();
	try {
		const previous = await env.KV.get<ModelDetail[]>("models", "json");
		const models = await fetchCatalog(Array.isArray(previous) ? previous : []);
		const updatedAt = new Date().toISOString();
		// The value is the public response body; one write publishes it with its timestamp.
		await env.KV.put("models", JSON.stringify(models), {
			metadata: { updatedAt } satisfies CatalogMetadata,
		});
		console.info({
			event: "catalog_sync_succeeded",
			updatedAt,
			models: models.length,
			tags: models.reduce((total, model) => total + model.tags.length, 0),
			durationMs: Date.now() - startedAt,
		});
		return { models: models.length, updatedAt };
	} catch (error) {
		console.error({
			event: "catalog_sync_failed",
			error: error instanceof Error ? error.message : String(error),
			durationMs: Date.now() - startedAt,
		});
		throw error;
	}
}

async function manualSync(request: Request, env: WorkerEnv): Promise<Response> {
	if (request.method !== "POST")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "POST" },
		});
	if (!env.SYNC_TOKEN)
		return Response.json(
			{ error: "Manual synchronization is not configured." },
			{ status: 503 },
		);
	if (request.headers.get("Authorization") !== `Bearer ${env.SYNC_TOKEN}`)
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	try {
		return Response.json(await syncCatalog(env));
	} catch {
		return Response.json(
			{ error: "Synchronization failed. Check Workers Logs for details." },
			{ status: 502 },
		);
	}
}

async function readCatalog(
	request: Request,
	env: WorkerEnv,
): Promise<Response> {
	if (request.method !== "GET")
		return new Response("Method Not Allowed", {
			status: 405,
			headers: { Allow: "GET" },
		});
	try {
		const { value, metadata } = await env.KV.getWithMetadata<CatalogMetadata>(
			"models",
			{ type: "stream", cacheTtl: 60 },
		);
		if (!value)
			return Response.json(
				{ error: "Catalog unavailable. Run a synchronization first." },
				{ status: 503, headers: CORS },
			);
		// Catalogs stored before timestamps were recorded have no metadata.
		const updatedAt = metadata?.updatedAt;
		const headers = new Headers({
			...CORS,
			"Access-Control-Expose-Headers": "X-Catalog-Updated-At, X-Catalog-Stale",
			"Content-Type": "application/json",
			"Cache-Control": "public, max-age=60",
			"X-Catalog-Stale": updatedAt
				? String(Date.now() - Date.parse(updatedAt) > STALE_AFTER_MS)
				: "unknown",
		});
		if (updatedAt) headers.set("X-Catalog-Updated-At", updatedAt);
		return new Response(value, { headers });
	} catch (error) {
		console.error({
			event: "catalog_read_failed",
			error: error instanceof Error ? error.message : String(error),
		});
		return Response.json(
			{ error: "Catalog temporarily unavailable." },
			{ status: 503, headers: CORS },
		);
	}
}

export default {
	async fetch(request: Request, env: WorkerEnv): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/sync") return manualSync(request, env);
		if (pathname === "/") return readCatalog(request, env);
		return new Response("Not Found", { status: 404 });
	},
	async scheduled(_controller, env) {
		// Let errors reach Cloudflare so the invocation is recorded as a failure.
		await syncCatalog(env);
	},
} satisfies ExportedHandler<WorkerEnv>;
