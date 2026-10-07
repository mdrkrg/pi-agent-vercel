<script lang="ts">
	import { MAX_TURNS } from "./storage.ts";

	let { sessionId }: { sessionId: string | undefined } = $props();
	const panelId = $props.id();
	let open = $state(false);
	let root: HTMLDivElement;
	const questions = [
		["Why am I waiting for a reply?", "Work starts on the scheduler's next pass; minute-based scheduling can add nearly a minute. Replies appear once complete, and polling faster does not speed execution up. If no reply arrives, check that the worker and scheduler are running."],
		["What access token should I use?", "Enter the server's APP_API_TOKEN. It is not saved in browser storage, so enter it again after refreshing."],
		["What is stored locally?", "Drafts, sent messages and retry information are stored as plain text in this tab. Tokens and replies are not saved; replies are fetched again from the server."],
		["Does closing the page stop the reply?", "No. Submitted work is not cancelled. After closing the tab, you may not be able to restore its local conversation history."],
		["Why use “Retry submission” after a failed send?", "Your message may have arrived without a confirmation. Retrying reuses the original message and request identity to avoid duplicates; do not send another copy."],
		["Does clearing history or starting a new chat delete old messages?", "These actions only affect this page. They do not delete server records or stop submitted work. Clearing history also removes the access token entered on this page."],
		["Are there input limits or keyboard shortcuts?", `Each chat on this page supports up to ${MAX_TURNS} turns and 65,536 characters per message. Press Ctrl / ⌘ + Enter to send.`],
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

<div class="faq" role="group" aria-label="Help" bind:this={root}
	onpointerenter={(event) => { if (event.pointerType !== "touch") open = true; }}
	onpointerleave={leave} onfocusin={() => { open = true; }} onfocusout={blur}>
	<button class="faq-trigger" type="button" aria-label="Frequently asked questions" aria-expanded={open} aria-controls={panelId}
		onclick={(event) => { event.currentTarget.focus(); open = true; }}>?</button>
	{#if open}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (The scrollable FAQ must be keyboard reachable.) -->
		<section class="faq-panel" id={panelId} aria-label="Frequently asked questions" tabindex="0">
			<strong>Frequently asked questions</strong>
			<dl>
				{#each questions as [question, answer] (question)}
					<dt>{question}</dt><dd>{answer}</dd>
				{/each}
			</dl>
			{#if sessionId}<small>Session ID: {sessionId}</small>{/if}
		</section>
	{/if}
</div>
