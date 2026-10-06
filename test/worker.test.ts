import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { syncCatalog, type WorkerEnv } from "../src/index";
import { library, tags } from "./fixtures";

const oldModels = [
	{ name: "old-model", description: "previous good data", tags: ["latest"] },
];

interface Metadata {
	updatedAt: string;
}

function environment(
	initial: unknown = null,
	token: string | null = "test-token",
	metadata: Metadata | null = null,
) {
	let stored = {
		value: initial === null ? null : JSON.stringify(initial),
		metadata,
	};
	const kv = {
		getWithMetadata: vi.fn(async () => stored),
		put: vi.fn(
			async (_key: string, value: string, options: { metadata: Metadata }) => {
				stored = { value, metadata: options.metadata };
			},
		),
	};
	return {
		env: {
			KV: kv as unknown as KVNamespace,
			SYNC_TOKEN: token ?? undefined,
		} satisfies WorkerEnv,
		kv,
	};
}

function syncRequest() {
	return new Request("https://test.invalid/sync", {
		method: "POST",
		headers: { Authorization: "Bearer test-token" },
	});
}

beforeEach(() => {
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (url: string) =>
				new Response(url.endsWith("/library") ? library : tags),
		),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("synchronization and publication", () => {
	it("publishes a complete catalog and timestamp in one write without Discord configuration", async () => {
		const { env, kv } = environment(oldModels, null);
		const { updatedAt } = await syncCatalog(env);
		expect(kv.put).toHaveBeenCalledExactlyOnceWith(
			"models",
			expect.any(String),
			{ metadata: { updatedAt } },
		);
		const models = JSON.parse(kv.put.mock.calls[0][1]);
		expect(models[0].tags).toHaveLength(3);
		expect(console.info).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "catalog_sync_succeeded",
				models: 1,
				tags: 3,
			}),
		);
		const response = await worker.fetch(
			new Request("https://test.invalid/"),
			env,
		);
		expect(await response.json()).toEqual(models);
		expect(response.headers.get("X-Catalog-Updated-At")).toBe(updatedAt);
		expect(response.headers.get("X-Catalog-Stale")).toBe("false");
	});
	it.each(["HTTP error", "empty library", "empty tags", "incomplete tags"])(
		"preserves the previous snapshot on %s",
		async (failure) => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string) => {
					if (failure === "HTTP error")
						return new Response("Unavailable", { status: 503 });
					if (url.endsWith("/library"))
						return new Response(
							failure === "empty library" ? "<html>Changed</html>" : library,
						);
					return new Response(
						failure === "empty tags"
							? "<html>Changed</html>"
							: `<a href="/library/qwen3:latest">latest</a>`,
					);
				}),
			);
			vi.useFakeTimers();
			const { env, kv } = environment(oldModels);
			const pending = worker.fetch(syncRequest(), env);
			await vi.runAllTimersAsync();
			const response = await pending;
			expect(response.status).toBe(502);
			expect(kv.put).not.toHaveBeenCalled();
			const read = await worker.fetch(
				new Request("https://test.invalid/"),
				env,
			);
			expect(await read.json()).toEqual(oldModels);
			expect(console.error).toHaveBeenCalledWith(
				expect.objectContaining({ event: "catalog_sync_failed" }),
			);
		},
	);
	it("propagates a Cron failure so Cloudflare records the invocation as failed", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Unavailable", { status: 503 })),
		);
		vi.useFakeTimers();
		const { env, kv } = environment(oldModels);
		const pending = expect(
			worker.scheduled({} as ScheduledController, env),
		).rejects.toThrow("HTTP 503");
		await vi.runAllTimersAsync();
		await pending;
		expect(kv.put).not.toHaveBeenCalled();
	});
	it("allows Cron to sync without a manual sync token", async () => {
		const { env, kv } = environment(null, null);
		await worker.scheduled({} as ScheduledController, env);
		expect(kv.put).toHaveBeenCalledOnce();
	});
	it("requires an authenticated POST for manual synchronization", async () => {
		const { env } = environment();
		expect(
			(await worker.fetch(new Request("https://test.invalid/sync"), env))
				.status,
		).toBe(405);
		expect(
			(
				await worker.fetch(
					new Request("https://test.invalid/sync", { method: "POST" }),
					env,
				)
			).status,
		).toBe(401);
		const disabled = environment(null, null);
		expect((await worker.fetch(syncRequest(), disabled.env)).status).toBe(503);
		expect(fetch).not.toHaveBeenCalled();
		expect((await worker.fetch(syncRequest(), env)).status).toBe(200);
	});
});

describe("public API reads", () => {
	it("keeps the legacy JSON array readable without inventing its freshness", async () => {
		const { env } = environment(oldModels);
		const response = await worker.fetch(
			new Request("https://test.invalid/"),
			env,
		);
		expect(await response.json()).toEqual(oldModels);
		expect(response.headers.get("X-Catalog-Stale")).toBe("unknown");
		expect(fetch).not.toHaveBeenCalled();
	});
	it("marks stale data while continuing to serve the last successful snapshot", async () => {
		const updatedAt = new Date(Date.now() - 27 * 60 * 60 * 1000).toISOString();
		const { env } = environment(oldModels, null, { updatedAt });
		const response = await worker.fetch(
			new Request("https://test.invalid/"),
			env,
		);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(oldModels);
		expect(response.headers.get("X-Catalog-Stale")).toBe("true");
	});
	it("returns 503 before the first synchronization without launching a scrape", async () => {
		const { env, kv } = environment();
		expect(
			(await worker.fetch(new Request("https://test.invalid/"), env)).status,
		).toBe(503);
		expect(fetch).not.toHaveBeenCalled();
		expect(kv.put).not.toHaveBeenCalled();
	});
	it("reports storage read failures instead of returning a success response", async () => {
		const { env, kv } = environment();
		kv.getWithMetadata.mockRejectedValueOnce(new Error("KV unavailable"));
		expect(
			(await worker.fetch(new Request("https://test.invalid/"), env)).status,
		).toBe(503);
		expect(console.error).toHaveBeenCalledWith(
			expect.objectContaining({ event: "catalog_read_failed" }),
		);
	});
});
