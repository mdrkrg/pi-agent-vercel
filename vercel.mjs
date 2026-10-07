const scheduler = process.env.AGENT_WORKER_SCHEDULER ?? "external";
if (scheduler !== "external" && scheduler !== "vercel-cron") {
	throw new Error("AGENT_WORKER_SCHEDULER must be external or vercel-cron");
}

/**
 * The external mode is Hobby-compatible. Pro and Enterprise can opt into the
 * native minute cron by setting AGENT_WORKER_SCHEDULER=vercel-cron at build time.
 */
const config = {
	$schema: "https://openapi.vercel.sh/vercel.json",
	framework: null,
	installCommand: "npx --yes pnpm@12.8.1 install --frozen-lockfile",
	buildCommand: "npx --yes pnpm@12.8.1 run build",
	outputDirectory: "dist",
	fluid: true,
	functions: {
		"api/index.ts": {
			maxDuration: 60,
			supportsCancellation: false,
		},
	},
	rewrites: [{ source: "/api/:path*", destination: "/api" }],
};

if (scheduler === "vercel-cron") {
	config.crons = [{ path: "/api/worker", schedule: "* * * * *" }];
}

export default config;
