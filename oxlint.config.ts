import { defineConfig } from "oxlint";

export default defineConfig({
	plugins: ["eslint", "typescript", "unicorn", "oxc", "react", "import", "promise"],
	ignorePatterns: [
		"scripts/**",
		// Imported via ?raw and executed in sandbox — not a real module.
		"src/shared/custom-tools/builtin/**",
	],
	rules: {
		// Preact doesn't freeze props; settings page uses intentional dirty-model mutations.
		"react/immutability": "off",
		// new Function() is used intentionally in sandbox/eval tools.
		"typescript/no-implied-eval": "off",
		// String() is used explicitly for tool parameters — safe conversion.
		"typescript/no-base-to-string": "off",
	},
});
