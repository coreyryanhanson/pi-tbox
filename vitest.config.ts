import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		setupFiles: ["__tests__/scrub-defer-env.ts"],
		include: ["__tests__/**/*.test.ts"],
		testTimeout: 15_000,
	},
});
