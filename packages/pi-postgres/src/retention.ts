import type { SqlExecutor } from "./sql.ts";

/** Deletes control-plane rows only after their retention horizon; Pi session data is explicit. */
export async function purgeSubmissionControlState(executor: SqlExecutor, olderThanMs: number): Promise<number> {
	if (!Number.isSafeInteger(olderThanMs) || olderThanMs < 0) throw new Error("olderThanMs must be non-negative");
	return executor.transaction(async (transaction) => {
	const result = await transaction.query<{ id: string }>(
		`DELETE FROM agent_delegated_tasks WHERE parent_submission_id IN
		 (SELECT id FROM agent_submissions WHERE updated_at < $1 AND status IN ('completed','failed','cancelled')) RETURNING id`,
		[olderThanMs],
	);
	const submissions = await transaction.query<{ id: string }>(
		"DELETE FROM agent_submissions WHERE updated_at < $1 AND status IN ('completed','failed','cancelled') RETURNING id",
		[olderThanMs],
	);
	return result.rowCount + submissions.rowCount;
	});
}
