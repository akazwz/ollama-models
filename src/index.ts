import { load } from "cheerio";
import { REST } from "@discordjs/rest";
import { Routes } from "discord-api-types/rest/v10";

interface ModelDetail {
	name: string;
	description: string;
	tags: string[];
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === "/sync") {
			const models = await fetchModels();
			const msg = `Synced ${models.length} ollama models`;
			const noTagModelNames = models
				.filter((model) => model.tags.length === 0)
				.map((model) => model.name);
			if (noTagModelNames.length > 0) {
				console.error(`No tag models: ${noTagModelNames.join(", ")}`);
				await sendDiscordMessage(
					env,
					`No tag models: ${noTagModelNames.join(", ")}`,
				);
			} else {
				await sendDiscordMessage(env, msg);
			}
			await env.KV.put("models", JSON.stringify(models));
			return new Response(msg, { status: 200 });
		}
		if (pathname === "/") {
			let models = await env.KV.get("models", { type: "json", cacheTtl: 60 });
			if (!models) {
				models = await fetchModels();
				ctx.waitUntil(env.KV.put("models", JSON.stringify(models)));
			}
			return Response.json(models);
		}
		return new Response("Not Found", { status: 404 });
	},
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const models = await fetchModels();
		const msg = `Synced ${models.length} ollama models`;
		const noTagModelNames = models
			.filter((model) => model.tags.length === 0)
			.map((model) => model.name);
		if (noTagModelNames.length > 0) {
			console.error(`No tag models: ${noTagModelNames.join(", ")}`);
			await sendDiscordMessage(
				env,
				`No tag models: ${noTagModelNames.join(", ")}`,
			);
		} else {
			await sendDiscordMessage(env, msg);
		}
		await env.KV.put("models", JSON.stringify(models));
	},
};

async function fetchModels(): Promise<ModelDetail[]> {
	const baseUrl = "https://ollama.com";
	const resp = await fetch(baseUrl.concat("/library"));
	const $ = load(await resp.text());
	const models: ModelDetail[] = [];
	const elements = $("#repo > ul").find("li");
	for (let i = 0; i < elements.length; i++) {
		const element = elements.get(i);
		const a = $(element).find("a");
		const name = a.find("h2").text().trim();
		const description = a.find("p").first().text().trim();
		const tagsHref = a.attr("href")?.concat("/tags");
		const tags: string[] = [];
		if (tagsHref) {
			const resp = await fetch(baseUrl.concat(tagsHref));
			const $ = load(await resp.text());
			$("ul li").each((_, element) => {
				const link = $(element).find("a");
				const href = link.attr("href");
				if (href?.includes(`/library/${name}`)) {
					const tag = href.split(`/library/${name}`)[1] || ":latest";
					const cleanTag = tag.startsWith(":") ? tag.slice(1) : tag;
					const fullTag = cleanTag ? `${name}:${cleanTag}` : `${name}:latest`;
					const pureTag = fullTag.split(":")[1];
					if (pureTag !== "latest") {
						tags.push(pureTag);
					}
				}
			});
		}
		const uniqueTags = Array.from(new Set(tags));
		models.push({
			name,
			description,
			tags: uniqueTags,
		});
	}
	return models;
}

async function sendDiscordMessage(env: Env, message: string) {
	const rest = new REST({
		version: "10",
	}).setToken(env.DISCORD_BOT_TOKEN);
	await rest.post(Routes.channelMessages(env.DISCORD_CHANNEL_ID), {
		body: {
			content: message,
		},
	});
}
