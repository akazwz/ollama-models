import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "ollama-models",
		entrypoint,
		compatibilityDate: "2026-09-29",
		compatibilityFlags: ["nodejs_compat"],
		observability: {
			enabled: true,
		},
		triggers: [triggers.scheduled({ schedule: "0 0 * * *" })],
		env: {
			// No id: deploys reuse the namespace already bound to the Worker, or create one.
			KV: bindings.kv(),
		},
	},
});
