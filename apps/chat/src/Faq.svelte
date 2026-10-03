<script lang="ts">
	import { MAX_TURNS } from "./storage.ts";

	let { sessionId }: { sessionId: string | undefined } = $props();
	const panelId = $props.id();
	let open = $state(false);
	let root: HTMLDivElement;
	const questions = [
		["为什么要等回复？", "后台按计划开始处理，使用分钟调度时可能等近 1 分钟。回复完成后一次显示；反复查看不会加快处理。一直没有回复时，检查 worker 和 scheduler 是否运行。"],
		["密钥填什么？", "填写服务端配置的 POC_API_TOKEN。它不会写入浏览器存储，刷新后需重新填写。"],
		["本地保存什么？", "草稿、已发消息和重试所需信息，明文保存在本标签页。不保存密钥或回复；回复会从服务器重新读取。"],
		["关闭页面会停止回复吗？", "不会取消已经发送的消息。关闭标签页后，可能无法恢复本页的对话记录。"],
		["提交失败后，为什么要点“重试提交”？", "消息可能已经送达，只是没有收到确认。重试会沿用原消息，避免创建重复消息；不要另发相同内容。"],
		["清除记录或新建对话会删除旧消息吗？", "只影响本页，不删除服务器记录，也不停止已提交的消息。清除记录还会移除本页填写的密钥。"],
		["有哪些输入限制和快捷键？", `本页每个对话最多 ${MAX_TURNS} 轮，每条消息最多 65,536 个字符。按 Ctrl / ⌘ + Enter 可以发送。`],
	];
	function leave() {
		if (!root.contains(document.activeElement)) open = false;
	}
	function blur(event: FocusEvent) {
		if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) open = false;
	}
</script>

<svelte:window
	onkeydown={(event) => { if (event.key === "Escape") open = false; }}
	onpointerdown={(event) => { if (event.target instanceof Node && !root.contains(event.target)) open = false; }}
/>

<div class="faq" role="group" aria-label="帮助" bind:this={root}
	onpointerenter={(event) => { if (event.pointerType !== "touch") open = true; }}
	onpointerleave={leave} onfocusin={() => { open = true; }} onfocusout={blur}>
	<button class="faq-trigger" type="button" aria-label="常见问题" aria-expanded={open} aria-controls={panelId}
		onclick={(event) => { event.currentTarget.focus(); open = true; }}>?</button>
	{#if open}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable FAQ must be keyboard reachable.) -->
		<section class="faq-panel" id={panelId} aria-label="常见问题" tabindex="0">
			<strong>常见问题</strong>
			<dl>
				{#each questions as [question, answer] (question)}
					<dt>{question}</dt><dd>{answer}</dd>
				{/each}
			</dl>
			{#if sessionId}<small>对话编号：{sessionId}</small>{/if}
		</section>
	{/if}
</div>
