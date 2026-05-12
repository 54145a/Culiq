import { resolve } from "node:path";
import { crx } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";
import manifest from "./src/manifest.json" with { type: "json" };

export default defineConfig({
	plugins: [crx({ manifest })],
	resolve: {
		alias: {
			"@shared": resolve(__dirname, "src/shared"),
		},
	},
	build: {
		target: "esnext",
		minify: false,
		sourcemap: true,
	},
	server: {
		port: 5173,
		strictPort: true,
		hmr: { port: 5174 },
	},
});
