<script lang="ts">
	import { onMount } from "svelte";
	import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
	import { createChat } from "./chat.ts";
	import { MAX_TURNS } from "./storage.ts";
	import Turn from "./Turn.svelte";
	import Faq from "./Faq.svelte";

	let storage: Storage | undefined;
	try { storage = window.sessionStorage; } catch { /* Private/blocked browser storage: memory-only mode. */ }
	const chat = createChat(undefined, storage);
	const chatState = chat.state;
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } });
	let tokenInput = $state("");
	let visible = $state(document.visibilityState !== "hidden");
	const unfinished = $derived($chatState.turns.find((turn) => !turn.terminal));
	const canSend = $derived(!!$chatState.token && !!$chatState.sessionId && !$chatState.busy && !unfinished
		&& !!$chatState.draft.trim() && $chatState.draft.length <= 65_536 && $chatState.turns.length < MAX_TURNS);
	onMount(() => {
		const update = () => { visible = document.visibilityState !== "hidden"; };
		document.addEventListener("visibilitychange", update);
		return () => { document.removeEventListener("visibilitychange", update); client.clear(); };
	});
	function connect(event: SubmitEvent) {
		event.preventDefault();
		client.clear();
		chat.setToken(tokenInput);
		tokenInput = "";
	}
	function clear() {
		if (($chatState.sessionId || $chatState.turns.length || $chatState.draft) && !window.confirm("Clear this page's history and access token? Submitted messages will not be deleted or cancelled.")) return;
		chat.clear(); client.clear(); tokenInput = "";
	}
	function newSession() {
		if ($chatState.sessionId && !window.confirm("Start a new chat? The previous conversation will no longer be shown on this page.")) return;
		void chat.newSession();
	}
</script>

<QueryClientProvider client={client}>
	<main>
		<header>
			<h1>Pi Chat</h1>
			<button onclick={clear}>Clear history</button>
		</header>
		<section class="connection" aria-label="Connection settings">
			<form onsubmit={connect}>
				<label for="token">Access token</label>
				<div class="row">
					<input id="token" type="password" bind:value={tokenInput} placeholder={$chatState.token ? "Token set" : "Enter access token"} autocomplete="off" spellcheck="false" disabled={$chatState.busy} />
					<button type="submit" disabled={!tokenInput.trim() || $chatState.busy}>Connect</button>
					<button type="button" onclick={newSession} disabled={!$chatState.token || $chatState.busy || !!unfinished}>New chat</button>
				</div>
			</form>
		</section>
		{#if $chatState.notice}<p role="alert">{$chatState.notice}</p>{/if}
		{#if $chatState.storageWarning}<p class="error" role="alert">Unable to save this chat. Keep this page open to retry; do not refresh or send a duplicate message.</p>{/if}
		<section class="transcript" aria-label="Conversation">
			{#if !$chatState.turns.length}
				<p class="muted">{$chatState.sessionId ? "Send a message to start." : "Connect, then start a new chat."}</p>
			{/if}
			{#each $chatState.turns as turn (turn.key)}
				<Turn {turn} token={$chatState.token} authEpoch={$chatState.authEpoch} {visible} onsettled={chat.settled} onauthfailed={chat.authFailed} />
			{/each}
		</section>
		<form class="composer" onsubmit={(event) => { event.preventDefault(); if (canSend) void chat.send(); }}>
			<label for="prompt">Message</label>
			<textarea id="prompt" rows="3" maxlength="65536" value={$chatState.draft}
				oninput={(event) => chat.setDraft(event.currentTarget.value)} placeholder="Type a message…"
				disabled={!$chatState.sessionId || $chatState.busy || !!unfinished}
				onkeydown={(event) => { if (!event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canSend) void chat.send(); } }}></textarea>
			<div class="row composer-actions">
				<small>{unfinished ? "Waiting for reply" : $chatState.turns.length >= MAX_TURNS ? "Start a new chat to continue" : ""}</small>
				{#if unfinished && !unfinished.submissionId}
					<button type="button" onclick={() => chat.send()} disabled={!$chatState.token || $chatState.busy}>{$chatState.busy ? "Submitting…" : "Retry submission"}</button>
				{:else}<button type="submit" disabled={!canSend}>{$chatState.busy ? "Working…" : "Send"}</button>{/if}
			</div>
		</form>
		<div class="faq-footer"><Faq sessionId={$chatState.sessionId} /></div>
	</main>
</QueryClientProvider>
