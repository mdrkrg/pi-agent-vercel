import { randomUUID } from "node:crypto";
import type { AgentHarnessOptions } from "@earendil-works/pi-agent-core";
import { withAbortSignal, type Context } from "@earendil-works/pi-agent-core/harness/context";
import { DriveJobRepo, PostgresSessionRepo, SessionLeaseManager, SubmissionRepo, type SessionLeaseOptions } from "../../pi-postgres/src/index.ts";
import { PostgresAdmission, type SubmissionHarnessFactory } from "./admission.ts";
import { PostgresRecoveryCoordinator } from "./recovery.ts";
import { PostgresSubmissionReader } from "./submission-reader.ts";

export type FunctionWorkerOptions<TContext extends object | undefined> = {
	readonly repo: PostgresSessionRepo;
	readonly submissions: SubmissionRepo;
	readonly leases: SessionLeaseManager;
	readonly jobs: DriveJobRepo;
	readonly discovery: Pick<AgentHarnessOptions<TContext>, "models" | "model">;
	readonly harnessOptions: SubmissionHarnessFactory<TContext>;
	readonly lease?: SessionLeaseOptions;
	readonly maxPassMs?: number;
	readonly maxInvocationMs?: number;
	readonly scanLimit?: number;
};

/** Call from cron or a local poller. The invocation carries no operation or principal state. */
export class PostgresFunctionWorker<TContext extends object | undefined = object | undefined> {
	constructor(private readonly options: FunctionWorkerOptions<TContext>) {}

	async tick(context: Context) {
		const controller = new AbortController();
		const budget = this.options.maxInvocationMs ?? 55_000;
		if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error("Function invocation budget must be positive");
		const signal = context.abortSignal === undefined ? controller.signal : AbortSignal.any([context.abortSignal, controller.signal]);
		const tickContext = withAbortSignal(signal, context);
		const timer = setTimeout(() => controller.abort(new Error("Function invocation budget exhausted")), budget);
		try {
			const admission = new PostgresAdmission({ repo: this.options.repo, submissions: this.options.submissions, leases: this.options.leases, harnessOptions: this.options.harnessOptions, ...(this.options.lease === undefined ? {} : { lease: this.options.lease }) });
			const pending = await admission.recoverPending(tickContext, this.options.scanLimit ?? 100);
			const coordinator = new PostgresRecoveryCoordinator({
				...this.options.discovery, repo: this.options.repo, jobs: this.options.jobs, leases: this.options.leases,
				workerId: randomUUID(), context: tickContext, maxPassMs: this.options.maxPassMs ?? 45_000,
				...(this.options.lease === undefined ? {} : { lease: this.options.lease }),
				harnessOptionsForJob: async (job, ownedContext) => {
					const submission = job.submissionId === null ? await this.options.submissions.findOperation(job.sessionId, job.lane, job.operationId) : await this.options.submissions.get(job.submissionId);
					if (submission === undefined || submission.sessionId !== job.sessionId || submission.lane !== job.lane || submission.operationId !== job.operationId) throw new Error("Drive job has no matching authorized submission");
					return this.options.harnessOptions(submission, ownedContext);
				},
			});
			const discovered = await coordinator.discover();
			const driven = await coordinator.run(1);
			tickContext.abortSignal?.throwIfAborted();
			const projections = await new PostgresSubmissionReader(this.options.repo, this.options.submissions).reconcilePending(this.options.scanLimit ?? 100, tickContext);
			return { pending, discovered: discovered.length, driven, projections };
		} finally { clearTimeout(timer); }
	}
}
