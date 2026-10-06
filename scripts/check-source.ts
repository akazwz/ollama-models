import process from "node:process";
import { fetchCatalog } from "../src/catalog.ts";

// Explicit live check: regular tests are offline and never depend on upstream availability.
const models = await fetchCatalog();
console.log(
	JSON.stringify({
		models: models.length,
		tags: models.reduce((total, model) => total + model.tags.length, 0),
	}),
);
for (const name of ["qwen3", "llama3.2-vision", "gemma4", "gpt-oss"]) {
	const model = models.find((entry) => entry.name === name);
	console.log(JSON.stringify({ name, tags: model?.tags.length ?? 0 }));
}
const qwen3 = models.find((model) => model.name === "qwen3");
for (const tag of ["30b-a3b-instruct-2507-q4_K_M", "4b-thinking-2507-q8_0"]) {
	if (!qwen3?.tags.includes(tag))
		throw new Error(`Issue #4 regression: missing qwen3:${tag}`);
}

const apiUrl = process.argv
	.find((arg) => arg.startsWith("--api="))
	?.slice("--api=".length);
if (apiUrl) {
	const response = await fetch(apiUrl, { signal: AbortSignal.timeout(15_000) });
	if (!response.ok)
		throw new Error(`Published API returned HTTP ${response.status}`);
	const published = (await response.json()) as typeof models;
	if (response.headers.get("X-Catalog-Stale") !== "false")
		throw new Error("Published catalog has unknown or stale freshness.");
	for (const model of models) {
		const actual = published.find((entry) => entry.name === model.name);
		if (!actual || model.tags.some((tag) => !actual.tags.includes(tag)))
			throw new Error(`Published catalog is incomplete for ${model.name}.`);
	}
	console.log("Published API contains the current source models and tags.");
}
