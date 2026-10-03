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
		if (($chatState.sessionId || $chatState.turns.length || $chatState.draft) && !window.confirm("清除本页记录和密钥？已发送的消息不会删除或停止处理。")) return;
		chat.clear(); client.clear(); tokenInput = "";
	}
	function newSession() {
		if ($chatState.sessionId && !window.confirm("开始新对话？本页将不再显示旧对话。")) return;
		void chat.newSession();
	}
</script>

<QueryClientProvider client={client}>
	<main>
		<header>
			<h1>Pi Chat</h1>
			<button onclick={clear}>清除记录</button>
		</header>
		<section class="connection" aria-label="连接设置">
			<form onsubmit={connect}>
				<label for="token">访问密钥</label>
				<div class="row">
					<input id="token" type="password" bind:value={tokenInput} placeholder={$chatState.token ? "已填写" : "输入密钥"} autocomplete="off" spellcheck="false" disabled={$chatState.busy} />
					<button type="submit" disabled={!tokenInput.trim() || $chatState.busy}>连接</button>
					<button type="button" onclick={newSession} disabled={!$chatState.token || $chatState.busy || !!unfinished}>新建对话</button>
				</div>
			</form>
		</section>
		{#if $chatState.notice}<p role="alert">{$chatState.notice}</p>{/if}
		{#if $chatState.storageWarning}<p class="error" role="alert">无法保存对话。请保留本页重试，勿刷新或重复发送。</p>{/if}
		<section class="transcript" aria-label="对话记录">
			{#if !$chatState.turns.length}
				<p class="muted">{$chatState.sessionId ? "发送消息开始对话。" : "连接后新建对话。"}</p>
			{/if}
			{#each $chatState.turns as turn (turn.key)}
				<Turn {turn} token={$chatState.token} authEpoch={$chatState.authEpoch} {visible} onsettled={chat.settled} onauthfailed={chat.authFailed} />
			{/each}
		</section>
		<form class="composer" onsubmit={(event) => { event.preventDefault(); if (canSend) void chat.send(); }}>
			<label for="prompt">消息</label>
			<textarea id="prompt" rows="3" maxlength="65536" value={$chatState.draft}
				oninput={(event) => chat.setDraft(event.currentTarget.value)} placeholder="输入消息…"
				disabled={!$chatState.sessionId || $chatState.busy || !!unfinished}
				onkeydown={(event) => { if (!event.isComposing && event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (canSend) void chat.send(); } }}></textarea>
			<div class="row composer-actions">
				<small>{unfinished ? "等待回复" : $chatState.turns.length >= MAX_TURNS ? "请新建对话继续" : ""}</small>
				{#if unfinished && !unfinished.submissionId}
					<button type="button" onclick={() => chat.send()} disabled={!$chatState.token || $chatState.busy}>{$chatState.busy ? "提交中…" : "重试提交"}</button>
				{:else}<button type="submit" disabled={!canSend}>{$chatState.busy ? "请求中…" : "发送"}</button>{/if}
			</div>
		</form>
		<div class="faq-footer"><Faq sessionId={$chatState.sessionId} /></div>
	</main>
</QueryClientProvider>
