import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

export default defineConfig(({ mode }) => ({
	plugins: [svelte(), ...(mode === "test" ? [svelteTesting()] : [])],
	build: { outDir: "../../dist", emptyOutDir: true },
	server: {
		port: 5173,
		strictPort: true,
		proxy: { "/api": { target: "http://127.0.0.1:3000", changeOrigin: true } },
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "jsdom",
		setupFiles: ["@testing-library/svelte/vitest"],
	},
}));
