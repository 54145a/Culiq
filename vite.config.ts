import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { crx, type ManifestV3Export } from "@crxjs/vite-plugin";
import { defineConfig } from "vite";

type Target = "chrome" | "firefox";

const target: Target = (process.env.TARGET as Target) || "chrome";
if (target !== "chrome" && target !== "firefox") {
	throw new Error(`Unknown TARGET=${target}, expected "chrome" or "firefox"`);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const base = readJson("./src/manifest.base.json");
const overlay = readJson(`./src/manifest.${target}.json`);
const manifest = { ...base, ...overlay } as ManifestV3Export;

export default defineConfig({
	plugins: [crx({ manifest, browser: target })],
	resolve: {
		alias: {
			"@shared": resolve(__dirname, "src/shared"),
		},
	},
	build: {
		target: "esnext",
		minify: false,
		sourcemap: true,
		outDir: `dist-${target}`,
		emptyOutDir: true,
		rollupOptions:
			target === "firefox"
				? {
						input: {
							sidepanel: resolve(__dirname, "src/sidepanel/index.html"),
						},
					}
				: undefined,
	},
	server: {
		port: 5173,
		strictPort: true,
		hmr: { port: 5174 },
	},
});
