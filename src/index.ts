import { load } from 'cheerio';

interface ModelDetail {
	name: string;
	description: string;
	tags: string[];
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const cache = caches.default;
		const cacheKey = new Request(request.url, request);
		let response = await cache.match(cacheKey);
		if (!response) {
			let models = await env.KV.get('models', { type: 'json' });
			if (!models) {
				models = await fetchModels();
				ctx.waitUntil(env.KV.put('models', JSON.stringify(models)));
			}
			const response = new Response(
				JSON.stringify({
					models,
				}),
				{
					headers: {
						'content-type': 'application/json',
					},
				},
			);
			ctx.waitUntil(cache.put(cacheKey, response.clone()));
			return response;
		}
		return response;
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const models = await fetchModels();
		await env.KV.put('models', JSON.stringify(models));
	},
};

async function fetchModels(): Promise<ModelDetail[]> {
	const baseUrl = 'https://ollama.com';
	const resp = await fetch(baseUrl.concat('/library'));
	const $ = load(await resp.text());
	const models: ModelDetail[] = [];
	const elements = $('#repo > ul').find('li');
	for (let i = 0; i < elements.length; i++) {
		const element = elements.get(i);
		const a = $(element).find('a');
		const name = a.find('h2').text().trim();
		const description = a.find('p').first().text().trim();
		const tagsHref = a.attr('href')?.concat('/tags');
		const tags: string[] = [];
		if (tagsHref) {
			const resp = await fetch(baseUrl.concat(tagsHref));
			const $ = load(await resp.text());
			let list = $('main > section').last().find('div > div > a');
			list.each((i, el) => {
				if (i === 0) return;
				const tag = $(el).text().trim();
				if (tag) {
					tags.push(tag);
				}
			});
		}
		models.push({
			name,
			description,
			tags,
		});
	}
	return models;
}
