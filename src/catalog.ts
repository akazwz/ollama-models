import { load } from "cheerio/slim";

export interface ModelDetail {
	name: string;
	description: string;
	tags: string[];
}

export interface LibraryModel {
	name: string;
	description: string;
	expectedTagCount?: number;
}

const ORIGIN = "https://ollama.com";
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

function libraryPath(href: string | undefined): string | undefined {
	if (!href) return;
	try {
		const url = new URL(href, ORIGIN);
		if (url.origin === ORIGIN) return decodeURIComponent(url.pathname);
	} catch {
		// Ignore malformed and external links; they are not catalog entries.
	}
}

export function parseLibrary(html: string): LibraryModel[] {
	const $ = load(html);
	const models = new Map<string, LibraryModel>();
	$("a[href]").each((_, element) => {
		const anchor = $(element);
		const path = libraryPath(anchor.attr("href"));
		const match = path?.match(/^\/library\/([a-z0-9][a-z0-9._-]*)$/);
		if (!match) return;
		const name = match[1];
		const text = anchor.text().replace(/\s+/g, " ");
		const count = text.match(/([\d,]+)\s+Tags\b/i);
		const description = anchor.find("p").first().text().trim();
		const expectedTagCount = count
			? Number(count[1].replaceAll(",", ""))
			: undefined;
		const previous = models.get(name);
		if (!previous || expectedTagCount !== undefined)
			models.set(name, { name, description, expectedTagCount });
	});
	if (models.size === 0)
		throw new Error(
			"Library page contains no model links; its layout may have changed.",
		);
	return [...models.values()];
}

export function parseTags(html: string, model: LibraryModel): string[] {
	const $ = load(html);
	const prefix = `/library/${model.name}:`;
	const tags = new Set<string>();
	$("a[href]").each((_, element) => {
		const path = libraryPath($(element).attr("href"));
		if (!path?.startsWith(prefix)) return;
		const tag = path.slice(prefix.length);
		if (/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(tag)) tags.add(tag);
	});
	if (tags.size === 0)
		throw new Error(`${model.name}: tags page contains no tag links.`);
	if (
		model.expectedTagCount !== undefined &&
		tags.size < model.expectedTagCount
	)
		throw new Error(
			`${model.name}: expected at least ${model.expectedTagCount} tags, found ${tags.size}.`,
		);
	return [...tags];
}

async function request(url: string): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		const response = await fetch(url, {
			signal: controller.signal,
			headers: {
				Accept: "text/html",
				"User-Agent":
					"ollama-models (+https://github.com/akazwz/ollama-models)",
			},
		});
		if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
		return await response.text();
	} catch (error) {
		if (controller.signal.aborted)
			throw new Error(
				`${url}: request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
			);
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchHtml(path: string): Promise<string> {
	const url = `${ORIGIN}${path}`;
	for (let attempt = 1; ; attempt++) {
		try {
			return await request(url);
		} catch (error) {
			if (attempt === MAX_ATTEMPTS) throw error;
			// One transient upstream failure should not cost a whole day's sync.
			console.warn({
				event: "catalog_fetch_retried",
				url,
				attempt,
				error: error instanceof Error ? error.message : String(error),
			});
			await new Promise((resolve) =>
				setTimeout(resolve, RETRY_DELAY_MS * attempt),
			);
		}
	}
}

export async function fetchCatalog(): Promise<ModelDetail[]> {
	const library = parseLibrary(await fetchHtml("/library"));
	const models: ModelDetail[] = [];
	for (let offset = 0; offset < library.length; offset += CONCURRENCY) {
		const batch = await Promise.all(
			library.slice(offset, offset + CONCURRENCY).map(async (model) => ({
				name: model.name,
				description: model.description,
				tags: parseTags(await fetchHtml(`/library/${model.name}/tags`), model),
			})),
		);
		models.push(...batch);
	}
	return models;
}
