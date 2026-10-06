import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCatalog, parseLibrary, parseTags } from "../src/catalog";

import { library, tags } from "./fixtures";

beforeEach(() => {
	vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Ollama page parsing", () => {
	it("uses canonical model links rather than the first list, heading text or CSS classes", () => {
		const html =
			library +
			`<a href="/library/qwen3">duplicate</a><a href="https://example.org/library/other">external</a><a href="/library/qwen3/tags">tags</a>`;
		expect(parseLibrary(html)).toEqual([
			{ name: "qwen3", description: "Qwen description", expectedTagCount: 3 },
		]);
	});
	it("supports the old heading and list layout too", () => {
		expect(
			parseLibrary(
				`<div id="repo"><ul><li><a href="/library/llama3"><h2>llama3</h2><p>Meta</p><p>1 Tags</p></a></li></ul></div>`,
			)[0].name,
		).toBe("llama3");
		expect(
			parseTags(
				`<ul><li><a href="/library/llama3:latest">latest</a></li></ul>`,
				{ name: "llama3", description: "" },
			),
		).toEqual(["latest"]);
	});
	it("extracts unique tags from the current div layout, including both issue #4 tags and latest", () => {
		const html =
			tags +
			`<a href="/library/qwen3-coder:latest">other model</a><a href="https://example.org/library/qwen3:fake">external</a>`;
		expect(
			parseTags(html, { name: "qwen3", description: "", expectedTagCount: 3 }),
		).toEqual([
			"latest",
			"30b-a3b-instruct-2507-q4_K_M",
			"4b-thinking-2507-q8_0",
		]);
	});
	it("rejects a changed library layout instead of treating it as an empty catalog", () => {
		expect(() => parseLibrary("<html>Maintenance</html>")).toThrow(
			"no model links",
		);
	});
	it("rejects missing and incomplete tag pages", () => {
		expect(() =>
			parseTags("<html>Maintenance</html>", { name: "qwen3", description: "" }),
		).toThrow("no tag links");
		expect(() =>
			parseTags(tags, { name: "qwen3", description: "", expectedTagCount: 4 }),
		).toThrow("expected at least 4 tags, found 3");
	});
});

function stubLibrary(count: number, tagsPage: (name: string) => Response) {
	const html = Array.from(
		{ length: count },
		(_, n) =>
			`<a href="/library/model${n}"><p>Description</p><span>1 Tags</span></a>`,
	).join("");
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) =>
			url.endsWith("/library")
				? new Response(html)
				: tagsPage(url.split("/").at(-2) ?? ""),
		),
	);
}

describe("catalog fetching", () => {
	it("rejects HTTP errors from the library page after retrying", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Unavailable", { status: 503 })),
		);
		const pending = expect(fetchCatalog()).rejects.toThrow("HTTP 503");
		await vi.runAllTimersAsync();
		await pending;
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it("keeps previous tags for a failing model, omits an unknown one and updates the rest", async () => {
		vi.useFakeTimers();
		stubLibrary(4, (name) =>
			name === "model0" || name === "model1"
				? new Response("Unavailable", { status: 503 })
				: new Response(`<a href="/library/${name}:latest">latest</a>`),
		);
		const pending = fetchCatalog([
			{ name: "model0", description: "old", tags: ["previous"] },
		]);
		await vi.runAllTimersAsync();
		expect(await pending).toEqual([
			{ name: "model0", description: "Description", tags: ["previous"] },
			{ name: "model2", description: "Description", tags: ["latest"] },
			{ name: "model3", description: "Description", tags: ["latest"] },
		]);
		expect(console.warn).toHaveBeenCalledWith(
			expect.objectContaining({
				event: "catalog_model_failed",
				model: "model1",
				keptPreviousTags: false,
			}),
		);
	});
	it("abandons the update when many models fail or none succeeds", async () => {
		stubLibrary(9, () => new Response("<html>Changed</html>"));
		await expect(fetchCatalog()).rejects.toThrow("More than 5 models failed");
		stubLibrary(2, () => new Response("<html>Changed</html>"));
		await expect(fetchCatalog()).rejects.toThrow("No model's tags");
	});
	it("retries a transient failure instead of failing the synchronization", async () => {
		vi.useFakeTimers();
		let failures = 2;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/library")) return new Response(library);
				return failures-- > 0
					? new Response("Unavailable", { status: 503 })
					: new Response(tags);
			}),
		);
		const pending = fetchCatalog();
		await vi.runAllTimersAsync();
		expect((await pending)[0].tags).toHaveLength(3);
		expect(console.warn).toHaveBeenCalledTimes(2);
	});
	it("times out stalled requests instead of hanging a synchronization", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, options: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						options.signal?.addEventListener(
							"abort",
							() => reject(new Error("Aborted")),
							{ once: true },
						);
					}),
			),
		);
		const pending = expect(fetchCatalog()).rejects.toThrow(
			"request timed out after 15000ms",
		);
		await vi.runAllTimersAsync();
		await pending;
		expect(fetch).toHaveBeenCalledTimes(3);
	});
	it("bounds simultaneous tag requests below the Workers connection limit and keeps model order", async () => {
		const html = Array.from(
			{ length: 9 },
			(_, n) =>
				`<a href="/library/model${n}"><p>Description</p><span>1 Tags</span></a>`,
		).join("");
		let active = 0;
		let maximum = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url.endsWith("/library")) return new Response(html);
				active++;
				maximum = Math.max(maximum, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				active--;
				const name = url.split("/").at(-2);
				return new Response(`<a href="/library/${name}:latest">latest</a>`);
			}),
		);
		const models = await fetchCatalog();
		expect(maximum).toBeLessThanOrEqual(4);
		expect(models.map((model) => model.name)).toEqual(
			Array.from({ length: 9 }, (_, n) => `model${n}`),
		);
	});
});
