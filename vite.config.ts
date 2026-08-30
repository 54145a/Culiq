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
const manifest = { ...base, ...overlay } as Record<string, unknown>;

// CI passes VERSION (e.g. "1.0.2") from the git tag so manifests match the release.
// Local dev builds keep the value hardcoded in manifest.base.json.
const versionOverride = process.env.VERSION?.trim();
if (versionOverride) {
	if (!/^\d+(\.\d+){0,3}$/.test(versionOverride)) {
		throw new Error(
			`Invalid VERSION="${versionOverride}". Chrome MV3 requires 1-4 dot-separated integers (e.g. "1.0.2").`,
		);
	}
	manifest.version = versionOverride;
}

export default defineConfig({
	plugins: [crx({ manifest: manifest as unknown as ManifestV3Export, browser: target })],
	resolve: {
		alias: {
			"@shared": resolve(__dirname, "src/shared"),
			react: "preact/compat",
			"react/jsx-runtime": "preact/jsx-runtime",
			"react-dom": "preact/compat",
		},
	},
	build: {
		target: "esnext",
		minify: false,
		sourcemap: true,
		outDir: `dist-${target}`,
		emptyOutDir: true,
		// CRXJS injects <link rel="modulepreload"> for shared chunks (e.g. the
		// `protocol` module imported across entry-points). Chrome warns when such a
		// preload is unused shortly after load. We rely on static import graphs
		// (no runtime dynamic import()), so the prefetch links are pure noise —
		// disable them to silence the console warning.
		modulePreload: false,
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
