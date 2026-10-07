export const STORAGE_KEY = "pi-live-chat:v1";
export const MAX_TURNS = 50;
export type Turn = { key: string; prompt: string; submissionId?: string; terminal: boolean };
export type Conversation = { sessionId?: string; draft: string; turns: Turn[] };
export const emptyConversation = (): Conversation => ({ draft: "", turns: [] });

function string(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}
export function loadConversation(storage?: Storage): Conversation {
	try {
		const raw = storage?.getItem(STORAGE_KEY);
		if (!raw) return emptyConversation();
		const data = JSON.parse(raw);
		if (data.version !== 1 || !Array.isArray(data.turns) || data.turns.length > MAX_TURNS
			|| typeof data.draft !== "string" || data.draft.length > 65_536
			|| (data.sessionId !== undefined && !string(data.sessionId, 1024))) return emptyConversation();
		const turns: Turn[] = [];
		for (const turn of data.turns) {
			if (!turn || !string(turn.key, 256) || !string(turn.prompt, 65_536) || typeof turn.terminal !== "boolean"
				|| (turn.submissionId !== undefined && !string(turn.submissionId, 1024))
				|| (turn.terminal && turn.submissionId === undefined)) return emptyConversation();
			turns.push({ key: turn.key, prompt: turn.prompt, terminal: turn.terminal,
				...(turn.submissionId === undefined ? {} : { submissionId: turn.submissionId }) });
		}
		if (turns.length > 0 && data.sessionId === undefined) return emptyConversation();
		if (new Set(turns.map((turn) => turn.key)).size !== turns.length
			|| turns.slice(0, -1).some((turn) => !turn.terminal)) return emptyConversation();
		return { draft: data.draft, turns, ...(data.sessionId === undefined ? {} : { sessionId: data.sessionId }) };
	} catch { return emptyConversation(); }
}

export function saveConversation(storage: Storage | undefined, conversation: Conversation): boolean {
	if (!storage) return false;
	try {
		// Explicit allowlist: never serialize in-memory credentials, API responses or errors.
		storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, sessionId: conversation.sessionId, draft: conversation.draft,
			turns: conversation.turns.map(({ key, prompt, submissionId, terminal }) => ({ key, prompt, submissionId, terminal })) }));
		return true;
	} catch { return false; }
}
