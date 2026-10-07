import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig } from "vitest/config";

const apiPort = Number(process.env.DEV_SERVICE_PORT ?? 3000);
if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error("Invalid DEV_SERVICE_PORT");

export default defineConfig(({ mode }) => ({
	plugins: [svelte(), ...(mode === "test" ? [svelteTesting()] : [])],
	build: { outDir: "../../dist", emptyOutDir: true },
	server: {
		port: 5173,
		strictPort: true,
		proxy: { "/api": { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "jsdom",
		setupFiles: ["@testing-library/svelte/vitest"],
	},
}));
