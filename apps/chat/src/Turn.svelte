<script lang="ts">
	import { createQuery } from "@tanstack/svelte-query";
	import { ApiError, ChatApi, outputText, pollInterval, statusText } from "./api.ts";
	import type { Turn } from "./storage.ts";

	let { turn, token, authEpoch, visible, onsettled, onauthfailed }: {
		turn: Turn; token: string; authEpoch: number; visible: boolean;
		onsettled: (key: string) => void; onauthfailed: () => void;
	} = $props();
	const api = new ChatApi();
	const view = createQuery(() => ({
		queryKey: ["submission", authEpoch, turn.submissionId],
		queryFn: ({ signal }) => api.view(turn.submissionId!, token, signal),
		enabled: !!token && !!turn.submissionId && visible && !turn.terminal,
		retry: false,
		refetchInterval: (query) => query.state.data?.result ? false
			: pollInterval(query.state.error, query.state.data?.submission.status === "waiting" || query.state.data?.submission.status === "accepted"),
		refetchIntervalInBackground: false,
	}));
	const result = createQuery(() => ({
		queryKey: ["result", authEpoch, turn.submissionId],
		queryFn: ({ signal }) => api.result(turn.submissionId!, token, signal),
		enabled: !!token && !!turn.submissionId && visible && (turn.terminal || !!view.data?.result),
		staleTime: Infinity,
		retry: false,
		refetchInterval: (query) => query.state.data ? false : pollInterval(query.state.error, false),
		refetchIntervalInBackground: false,
	}));
	const error = $derived(result.error ?? view.error);
	$effect(() => {
		if (result.data && !turn.terminal) onsettled(turn.key);
	});
	$effect(() => {
		if (error instanceof ApiError && [401, 403].includes(error.status)) onauthfailed();
	});
</script>

<article class="turn">
	<div class="message"><strong>You</strong><p>{turn.prompt}</p></div>
	<div class="message">
		<strong>Pi</strong>
		{#if result.data}
			<p>{outputText(result.data)}</p>
			{#if result.data.result.status !== "completed"}
				<p class="error">{result.data.result.status === "failed" ? "Turn failed" : "Turn cancelled"}{result.data.result.error?.code ? ` · ${result.data.result.error.code}` : ""}</p>
			{/if}
		{:else if !token}<p class="muted">Connect to view the reply.</p>
		{:else if !turn.submissionId}<p class="muted">{turn.terminal ? "Finished" : "Submission unconfirmed. Please retry."}</p>
		{:else}
			<p class="muted" role="status">{visible ? turn.terminal || view.data?.result ? "Reading reply" : statusText(view.data) : "Polling paused"}</p>
		{/if}
		{#if error && token}
			<p class="error" role="alert">{error.message}</p>
			<button onclick={() => result.error ? result.refetch() : view.refetch()} disabled={!visible}>Refresh reply</button>
		{/if}
	</div>
</article>
