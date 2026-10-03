import { get, writable } from "svelte/store";
import { ApiError, ChatApi } from "./api.ts";
import { emptyConversation, loadConversation, MAX_TURNS, saveConversation, STORAGE_KEY, type Conversation } from "./storage.ts";

export type ChatState = Conversation & { token: string; authEpoch: number; busy: boolean; notice: string; storageWarning: boolean };
export function createChat(api = new ChatApi(), storage?: Storage, uuid = () => crypto.randomUUID()) {
	const state = writable<ChatState>({ ...loadConversation(storage), token: "", authEpoch: 0, busy: false, notice: "", storageWarning: !storage });
	let generation = 0;
	let mutation: AbortController | undefined;
	function persist(value: ChatState): ChatState {
		return { ...value, storageWarning: !saveConversation(storage, value) };
	}
	function failed(error: unknown, fallback: string) {
		state.update((value) => ({ ...value, busy: false, notice: `${error instanceof Error ? error.message : "请求失败。"} ${fallback}`,
			...(error instanceof ApiError && [401, 403].includes(error.status) ? { token: "", authEpoch: value.authEpoch + 1 } : {}) }));
	}
	return {
		state,
		setToken(token: string) {
			if (get(state).busy) return;
			state.update((value) => ({ ...value, token: token.trim(), authEpoch: value.authEpoch + 1, notice: "" }));
		},
		setDraft(draft: string) { state.update((value) => persist({ ...value, draft })); },
		async newSession() {
			const before = get(state);
			if (before.busy || !before.token || before.turns.some((turn) => !turn.terminal)) return;
			const epoch = generation;
			mutation = new AbortController();
			state.update((value) => ({ ...value, busy: true, notice: "" }));
			try {
				const response = await api.createSession(before.token, mutation.signal);
				if (generation !== epoch) return;
				state.update((value) => persist({ ...value, ...emptyConversation(), sessionId: response.session.id, busy: false }));
			} catch (error) {
				if (generation === epoch) failed(error, "可能已创建对话，但未收到确认。请检查连接，再手动重试。");
			}
		},
		async send() {
			const before = get(state);
			if (before.busy || !before.token || !before.sessionId) return;
			let turn = before.turns.find((item) => !item.terminal);
			if (turn?.submissionId) return;
			if (!turn) {
				if (!before.draft.trim() || before.draft.length > 65_536 || before.turns.length >= MAX_TURNS) return;
				turn = { key: uuid(), prompt: before.draft, terminal: false };
				const pending = turn;
				// Persist identity and exact payload BEFORE the request, including response-loss cases.
				state.update((value) => persist({ ...value, draft: "", turns: [...value.turns, pending] }));
			}
			const pending = turn;
			const epoch = generation;
			mutation = new AbortController();
			state.update((value) => ({ ...value, busy: true, notice: "" }));
			try {
				const response = await api.submit(before.sessionId, pending.key, pending.prompt, before.token, mutation.signal);
				if (generation !== epoch) return;
				state.update((value) => persist({ ...value, busy: false, turns: value.turns.map((item) =>
					item.key === pending.key ? { ...item, submissionId: response.submission.id } : item) }));
			} catch (error) {
				if (generation === epoch) failed(error, "请点“重试提交”，不要另发一条。");
			}
		},
		settled(key: string) {
			state.update((value) => persist({ ...value, turns: value.turns.map((turn) => turn.key === key ? { ...turn, terminal: true } : turn) }));
		},
		authFailed() {
			state.update((value) => ({ ...value, token: "", authEpoch: value.authEpoch + 1, notice: "密钥无效或没有权限，请重新填写。" }));
		},
		clear() {
			generation++;
			mutation?.abort();
			let storageWarning = !storage;
			try { storage?.removeItem(STORAGE_KEY); storageWarning ||= storage?.getItem(STORAGE_KEY) !== null; }
			catch { storageWarning = true; }
			state.update((value) => ({ ...emptyConversation(), token: "", authEpoch: value.authEpoch + 1, busy: false,
				notice: "本页记录已清除。", storageWarning }));
		},
	};
}
